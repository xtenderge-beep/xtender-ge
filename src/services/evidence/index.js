const crypto = require('crypto');
const pool = require('../../config/db');
const redis = require('../../config/redis');
const consentLog = require('../consentLog.service');
const otpService = require('../otp.service');
const { toE164, phoneVariants } = require('../../config/phone');
const labels = require('./labels');
const subjects = require('./subject');

// Выгрузка архива доказательств: администратор уже вошёл (пароль и код), указывает субъект, цель и причину; на
// ADMIN_PHONE уходит отдельный код, привязанный к этому запросу и этой сессии (доверенное устройство его не
// заменяет). Каждый запрос, отказ и выгрузка — запись в журнале согласий: её нельзя изменить или удалить, она
// входит в цепочку отпечатков. Архив на сервере не хранится; хранится его SHA-256 и внешняя метка времени на него.
const OTP_PURPOSE = 'evidence_export';
const REQUEST_TTL_SECONDS = 600;
const PENDING_KEY = 'evidence:pending';
const requestKey = (id) => `evidence:request:${id}`;
const sessionHash = (session) => crypto.createHash('sha256').update(String(session?.csrfToken || '')).digest('hex').slice(0, 16);

function adminPhone() {
  return process.env.ADMIN_PHONE ? toE164(process.env.ADMIN_PHONE) : null;
}

// Субъект из формы: profile:<id> или phone:<номер>.
function parseSubject(value) {
  const text = String(value || '');
  const profile = /^profile:(\d{1,9})$/.exec(text);
  if (profile) return { type: 'profile', id: Number(profile[1]) };
  const phone = /^phone:(.+)$/.exec(text);
  if (phone && phoneVariants(phone[1]).length && subjects.tail(phone[1]).length === 9) return { type: 'phone', phone: `+995${subjects.tail(phone[1])}` };
  return null;
}

async function subjectPhone(subject) {
  if (subject.type === 'phone') return subject.phone;
  const found = await subjects.profile(subject.id);
  return found.phone || found.periods.map((period) => period.phone).filter(Boolean).pop() || `profile#${subject.id}`;
}

async function log(eventType, subject, metadata, meta) {
  const phone = subject ? await subjectPhone(subject) : (adminPhone() || 'unknown');
  return consentLog.recordAction({ eventType, phone, masterId: subject?.type === 'profile' ? subject.id : null, metadata: { actor: 'admin', ...metadata }, meta });
}

async function deny(subject, reason, extra, meta) {
  await log('EVIDENCE_EXPORT_DENIED', subject, { reason, ...extra }, meta).catch((error) => console.error('[evidence] deny log failed:', error.message));
  require('../telegram.service').sendSecurityAlert(`⚠️ Выгрузка доказательств отклонена: ${reason}${extra?.request_id ? ' (запрос ' + extra.request_id + ')' : ''}.`).catch(() => {});
}

// Шаг 1: проверить запрос, отправить код, запомнить запрос.
async function request({ subject: rawSubject, purpose, reason, session, meta = {} }) {
  const subject = parseSubject(rawSubject);
  const text = String(reason || '').trim();
  if (!subject) return { error: 'Не выбран профиль или номер.' };
  if (!labels.PURPOSES[purpose]) return { error: 'Выберите цель выгрузки.' };
  if (text.length < 10 || text.length > 500) return { error: 'Опишите причину выгрузки: от 10 до 500 знаков.' };
  const phone = adminPhone();
  if (!phone) { await deny(subject, 'no_admin_phone', { purpose }, meta); return { error: 'Выгрузка недоступна: не задан телефон администратора (ADMIN_PHONE) для кода подтверждения.' }; }
  const id = crypto.randomBytes(6).toString('hex');
  await redis.set(requestKey(id), JSON.stringify({ subject, purpose, reason: text, session: sessionHash(session), createdAt: new Date().toISOString() }), 'EX', REQUEST_TTL_SECONDS);
  const sent = await otpService.sendCode(phone, OTP_PURPOSE, null, { meta });
  if (!sent.success) {
    await redis.del(requestKey(id));
    await deny(subject, sent.reason === 'rate_limited' ? 'code_rate_limited' : 'code_not_sent', { request_id: id, purpose }, meta);
    return { error: sent.reason === 'rate_limited' ? 'Слишком много кодов за час. Подождите.' : 'Код не отправлен. Попробуйте позже.' };
  }
  await redis.set(PENDING_KEY, id, 'EX', REQUEST_TTL_SECONDS);
  await log('EVIDENCE_EXPORT_REQUESTED', subject, { request_id: id, purpose, reason: text }, meta);
  return { requestId: id, subject, purpose, reason: text };
}

// Шаг 2: код → архив. Код действует только для последнего запроса и той же сессии.
async function complete({ requestId, code, session, meta = {} }) {
  const raw = /^[0-9a-f]{12}$/.test(String(requestId || '')) ? await redis.get(requestKey(requestId)) : null;
  if (!raw) { await deny(null, 'request_expired', { request_id: String(requestId || '').slice(0, 20) }, meta); return { error: 'Запрос устарел. Начните выгрузку заново.' }; }
  const pending = JSON.parse(raw);
  if (pending.session !== sessionHash(session)) { await deny(pending.subject, 'other_session', { request_id: requestId }, meta); return { error: 'Код подтверждает выгрузку только в той сессии, где её запросили.' }; }
  if ((await redis.get(PENDING_KEY)) !== requestId) { await deny(pending.subject, 'superseded', { request_id: requestId }, meta); return { error: 'После этого запроса был другой. Используйте последний.' }; }
  const ok = /^\d{4,8}$/.test(String(code || '').trim()) && await otpService.verifyCode(adminPhone(), String(code).trim(), OTP_PURPOSE, { recordConsent: false });
  if (!ok) { await deny(pending.subject, 'wrong_code', { request_id: requestId }, meta); return { error: 'Неверный код.', retry: true }; }
  await redis.del(requestKey(requestId));
  await redis.del(PENDING_KEY);
  let result;
  try {
    result = await require('./build').build({ subject: pending.subject, purpose: pending.purpose, reason: pending.reason, exportId: requestId });
  } catch (error) {
    console.error('[evidence] build failed:', error);
    await deny(pending.subject, 'build_failed', { request_id: requestId, error: error.message.slice(0, 200) }, meta);
    return { error: 'Архив не собран: ' + error.message };
  }
  if (!result) { await deny(pending.subject, 'not_found', { request_id: requestId }, meta); return { error: 'По этому субъекту записей нет.' }; }
  // Внешняя метка времени на отпечаток самого архива: её ответ хранится в записи о выгрузке.
  const stamp = await require('./tsa').stamp(result.sha256).catch(() => null);
  const entry = await log('EVIDENCE_EXPORTED', pending.subject, {
    request_id: requestId, purpose: pending.purpose, reason: pending.reason, archive_sha256: result.sha256, archive_bytes: result.archive.length,
    files: result.files.length, counts: result.manifest.counts, export_anchor_id: result.manifest.export_anchor?.id || null,
    archive_tsa: stamp ? { url: stamp.url, time: stamp.genTime, response: stamp.response } : null,
  }, meta);
  require('../telegram.service').sendSecurityAlert(`📦 Выгрузка доказательств ${requestId}: ${result.title}. Цель: ${labels.PURPOSES[pending.purpose].ru}.\n`
    + `SHA-256 архива: ${result.sha256}\n${stamp ? 'Метка времени: ' + new URL(stamp.url).host + ', ' + (stamp.genTime ? stamp.genTime.toISOString() : '') : 'Метку времени получить не удалось.'}`).catch(() => {});
  const name = `xtender-evidence-${requestId}-${pending.subject.type === 'profile' ? 'profile-' + pending.subject.id : 'phone-' + subjects.tail(pending.subject.phone).slice(-3)}.zip`;
  return { archive: result.archive, filename: name, sha256: result.sha256, logId: entry?.id || null };
}

async function recent(limit = 50) {
  const rows = (await pool.query(`SELECT id, event_type, phone_number, master_id, metadata, timestamp_utc FROM sms_consent_logs
    WHERE event_type IN ('EVIDENCE_EXPORT_REQUESTED', 'EVIDENCE_EXPORTED', 'EVIDENCE_EXPORT_DENIED') ORDER BY id DESC LIMIT $1`, [limit])).rows;
  return rows.map((row) => {
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
    return { id: Number(row.id), event: row.event_type, time: row.timestamp_utc, masterId: row.master_id, phone: row.phone_number, requestId: metadata.request_id || null,
      purpose: metadata.purpose || null, reason: metadata.reason || null, sha256: metadata.archive_sha256 || null, denied: metadata.reason && row.event_type === 'EVIDENCE_EXPORT_DENIED' ? metadata.reason : null,
      tsa: metadata.archive_tsa ? { url: metadata.archive_tsa.url, time: metadata.archive_tsa.time } : null };
  });
}

// Квитанция метки времени на архив (.tsr) из записи о выгрузке.
async function receipt(logId) {
  const row = (await pool.query("SELECT metadata FROM sms_consent_logs WHERE id = $1 AND event_type = 'EVIDENCE_EXPORTED'", [logId])).rows[0];
  const metadata = row ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
  return metadata?.archive_tsa?.response ? { data: Buffer.from(metadata.archive_tsa.response, 'base64'), sha256: metadata.archive_sha256, requestId: metadata.request_id } : null;
}

module.exports = { request, complete, recent, receipt, parseSubject, OTP_PURPOSE };
