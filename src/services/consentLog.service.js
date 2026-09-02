const crypto = require('crypto');
const pool = require('../config/db');

// Журнал согласий на SMS + доставок (Double Opt-In / аудит). Таблица sms_consent_logs
// строго append-only — здесь только INSERT и SELECT, никаких UPDATE/DELETE.
// Схема и обоснование дизайна — в schema.sql, блок «Журнал согласий на SMS».

const PROVIDER = 'sms_gateway';

// Пустая перчинка = чистый SHA-256 кода (как в ТЗ). Заданная в env — защищает от
// перебора 4-значного кода по дампу БД (10k вариантов).
const PEPPER = process.env.CONSENT_HASH_PEPPER || '';

function sha256(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function hashOtp(code) {
  return sha256(`${PEPPER}:${code}`);
}

const VERIFIED_EVENT_BY_PURPOSE = {
  master: 'CONSENT_SMS_OTP_VERIFIED',
  master_login: 'AUTH_SMS_OTP_VERIFIED',
  order: 'ORDER_SMS_OTP_VERIFIED',
  review: 'REVIEW_SMS_OTP_VERIFIED',
};

// `channel` не пишем — колонка сама дефолтится в 'sms' (явный NULL перебил бы DEFAULT).
const COLUMNS = [
  'event_type', 'phone_number', 'master_id', 'order_id', 'purpose',
  'ip_address', 'user_agent', 'x_forwarded_for', 'otp_reference_id', 'provider',
  'provider_response', 'otp_code_hash', 'message_body_hash', 'terms_version',
  'consent_language', 'consent_text_snapshot', 'metadata',
];
const JSON_COLUMNS = new Set(['provider_response', 'metadata']);

async function insertRow(values, client = pool) {
  const params = COLUMNS.map((col) => {
    const v = values[col];
    if (v === undefined || v === null) return null;
    // JSONB-колонки: всегда сериализуем, в т.ч. строки — шлюз может вернуть голый текст
    // ("OK 12345"), а не JSON; JSON.stringify оборачивает его в валидный JSON-литерал.
    if (JSON_COLUMNS.has(col)) return JSON.stringify(v);
    return v;
  });
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO sms_consent_logs (${COLUMNS.join(', ')})
     VALUES (${placeholders})
     RETURNING id, event_type, timestamp_utc`,
    params
  );
  return rows[0];
}

// --- Точка 2: факт отправки OTP-SMS (вызывается из otp.service после отправки) ---
// best-effort: потеря строки журнала отправки не должна ронять саму отправку кода.
async function recordOtpSent({ phone, purpose, code, masterId = null, orderId = null,
  providerMessageId = null, providerResponse = null, meta = {} }) {
  try {
    return await insertRow({
      event_type: 'SMS_OTP_SENT',
      phone_number: phone,
      master_id: masterId,
      order_id: orderId,
      purpose,
      ip_address: meta.ip || null,
      user_agent: meta.userAgent || null,
      x_forwarded_for: meta.xForwardedFor || null,
      otp_reference_id: providerMessageId,
      provider: PROVIDER,
      provider_response: providerResponse,
      otp_code_hash: code ? hashOtp(code) : null,
    });
  } catch (err) {
    console.error('consentLog.recordOtpSent failed:', err.message);
    return null;
  }
}

// --- Точка 1: подтверждение OTP-кода = момент согласия (вызывается из otp.verifyCode) ---
// НЕ ловит ошибку: вызывающий сам решает, критично ли это (для регистрации на /join —
// критично, verify должен упасть; для входа/заявки/отзыва — залогировать и продолжить).
async function recordConsentVerified({ phone, purpose, submittedCode, masterId = null, orderId = null,
  termsVersion = null, language = null, consentText = null,
  providerMessageId = null, providerResponse = null, meta = {} }) {
  return insertRow({
    event_type: VERIFIED_EVENT_BY_PURPOSE[purpose] || 'SMS_OTP_VERIFIED',
    phone_number: phone,
    master_id: masterId,
    order_id: orderId,
    purpose,
    ip_address: meta.ip || null,
    user_agent: meta.userAgent || null,
    x_forwarded_for: meta.xForwardedFor || null,
    otp_reference_id: providerMessageId,
    provider: PROVIDER,
    provider_response: providerResponse,
    otp_code_hash: submittedCode ? hashOtp(submittedCode) : null,
    terms_version: termsVersion,
    consent_language: language,
    consent_text_snapshot: consentText,
  });
}

// --- Точка 2: прочие транзакционные SMS (лид-уведомления, подтверждения, пинки) ---
// Вызывается из sms.service на каждую отправку не-OTP SMS. best-effort.
async function recordSmsDelivery({ phone, kind = 'transactional', body = null, purpose = null,
  masterId = null, orderId = null, providerMessageId = null, providerResponse = null, meta = {} }) {
  try {
    return await insertRow({
      event_type: kind === 'lead' ? 'LEAD_SMS_SENT' : 'TX_SMS_SENT',
      phone_number: phone,
      master_id: masterId,
      order_id: orderId,
      purpose,
      ip_address: meta.ip || null,
      user_agent: meta.userAgent || null,
      x_forwarded_for: meta.xForwardedFor || null,
      otp_reference_id: providerMessageId,
      provider: PROVIDER,
      provider_response: providerResponse,
      message_body_hash: body ? sha256(body) : null,
      metadata: meta.extra || null,
    });
  } catch (err) {
    console.error('consentLog.recordSmsDelivery failed:', err.message);
    return null;
  }
}

// --- Выгрузка по запросу регулятора (PDPS) или SMS-оператора ---
// Вход: номер в любом формате записи ИЛИ id профиля. Выход: JSON со всем, что известно
// по номеру — профиль(и) на этот номер + полный журнал событий в хронологии.
async function exportForPhone(rawPhone) {
  const { phoneVariants } = require('../config/phone');
  const variants = phoneVariants(rawPhone);
  if (!variants.length) {
    return { report_type: 'sms_consent_audit', query: { phone: rawPhone }, error: 'invalid_phone' };
  }

  const ph = variants.map((_, i) => `$${i + 1}`).join(', ');
  const [logs, masters] = await Promise.all([
    pool.query(
      `SELECT * FROM sms_consent_logs WHERE phone_number IN (${ph})
       ORDER BY timestamp_utc ASC, id ASC`,
      variants
    ),
    pool.query(
      `SELECT id, name, phone, category, is_active, is_banned, created_at, terms_accepted_at
       FROM masters WHERE phone IN (${ph})`,
      variants
    ),
  ]);

  const optIn = logs.rows.find((r) => r.event_type === 'CONSENT_SMS_OTP_VERIFIED') || null;

  return {
    report_type: 'sms_consent_audit',
    generated_at_utc: new Date().toISOString(),
    query: { phone: rawPhone, matched_phone_formats: variants },
    subject: {
      profiles: masters.rows,
      double_opt_in: optIn
        ? {
            opted_in_at_utc: optIn.timestamp_utc,
            terms_version: optIn.terms_version,
            consent_language: optIn.consent_language,
            consent_text_shown: optIn.consent_text_snapshot,
            ip_address: optIn.ip_address,
            user_agent: optIn.user_agent,
            x_forwarded_for: optIn.x_forwarded_for,
            otp_reference_id: optIn.otp_reference_id,
            otp_code_sha256: optIn.otp_code_hash,
            log_row_id: optIn.id,
          }
        : null,
    },
    event_count: logs.rows.length,
    events: logs.rows,
  };
}

const VERIFIED_EVENT_TYPES = Object.values(VERIFIED_EVENT_BY_PURPOSE);

// Последние подтверждённые согласия — для landing-страницы /admin/consent.
// Джойн по phone_number ↔ masters.phone (FK нет, см. schema.sql).
async function listRecentConsents(limit = 100) {
  const ph = VERIFIED_EVENT_TYPES.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT l.id, l.event_type, l.phone_number, l.purpose, l.ip_address, l.user_agent,
            l.terms_version, l.consent_language, l.otp_reference_id, l.timestamp_utc,
            m.id AS master_id, m.name AS master_name, m.is_active AS master_active
     FROM sms_consent_logs l
     LEFT JOIN masters m ON m.phone = l.phone_number
     WHERE l.event_type IN (${ph})
     ORDER BY l.timestamp_utc DESC, l.id DESC
     LIMIT $${VERIFIED_EVENT_TYPES.length + 1}`,
    [...VERIFIED_EVENT_TYPES, limit]
  );
  return rows;
}

async function exportForMaster(masterId) {
  const { rows } = await pool.query('SELECT phone FROM masters WHERE id = $1', [masterId]);
  if (!rows[0]) {
    return { report_type: 'sms_consent_audit', query: { master_id: masterId }, error: 'master_not_found' };
  }
  const report = await exportForPhone(rows[0].phone);
  report.query.master_id = masterId;
  return report;
}

module.exports = {
  recordOtpSent,
  recordConsentVerified,
  recordSmsDelivery,
  exportForPhone,
  exportForMaster,
  listRecentConsents,
  // экспортируем хелперы для тестов/скриптов
  _hashOtp: hashOtp,
};
