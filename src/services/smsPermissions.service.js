const pool = require('../config/db');
const consentLog = require('./consentLog.service');
const audit = require('./masterAudit.service');
const { translate } = require('../config/i18n');

// Два независимых разрешения исполнителя на SMS (и Telegram): заявки (masters.is_subscribed) и предложения
// Xtender (masters.marketing_sms). Тексты — в provider-consent-copy.js; при регистрации их выбор приходит в
// снимке согласия (consent.service), позже меняется в кабинете. Каждое включение пишется в журнал с точным
// показанным текстом и его версией, выключение — фактом и временем (ст. 12(9) закона о персональных данных).
// Предложения включаются только этой отметкой: вход по коду и повторная регистрация их не возвращают.
const KINDS = {
  lead: { title: 'signup_lead_sms_title', text: 'signup_lead_sms' },
  marketing: { title: 'signup_marketing_sms_title', text: 'signup_marketing_sms' },
};

function permissionText(kind, language) {
  const t = translate(language);
  const text = `${t(KINDS[kind].title)}. ${t(KINDS[kind].text)}`;
  return { text, version: consentLog.textVersion(text) };
}

// Выбор при регистрации (грант подтверждённого кода). Старые снимки без выбора — прежняя единая отметка,
// где согласие на сообщения о заявках входило в оферту: заявки остаются включёнными, предложений нет.
async function applyRegistration(masterId, phone, grant, meta = {}) {
  const snapshot = grant?.snapshot || {};
  const choices = snapshot.choices;
  if (!choices) return { lead: true, marketing: false, legacy: true };
  const language = snapshot.language || 'ka';
  await pool.withTransaction(async (client) => {
    await client.query('UPDATE masters SET is_subscribed=$1, marketing_sms=$2, marketing_sms_at=$3 WHERE id=$4',
      [choices.lead_sms === true, choices.marketing_sms === true, choices.marketing_sms === true ? new Date() : null, masterId]);
    for (const [kind, on, eventType] of [['lead', choices.lead_sms, 'LEAD_SMS_OPT_IN'], ['marketing', choices.marketing_sms, 'MARKETING_SMS_OPT_IN']]) {
      if (on !== true) continue;
      const permission = permissionText(kind, language);
      await consentLog.recordAction({ eventType, phone, masterId, metadata: { actor: 'provider', source: 'registration', consent_log_id: grant.consentLogId },
        meta, consentText: permission.text, language, version: permission.version }, client);
    }
  });
  return { lead: choices.lead_sms === true, marketing: choices.marketing_sms === true, legacy: false };
}

// Предложения Xtender из кабинета или по ссылке отказа. Включение — только с показанным текстом согласия.
async function setMarketing(masterId, enabled, { language = 'ka', source = 'cabinet', actor = 'provider', meta = {}, reason = null } = {}) {
  const on = enabled === true;
  const result = await pool.withTransaction(async (client) => {
    const master = (await client.query('SELECT id, phone, is_banned, marketing_sms FROM masters WHERE id=$1 FOR UPDATE', [masterId])).rows[0];
    if (!master || (master.is_banned && on)) return null;
    if (master.marketing_sms === on) return { on, changed: false };
    await client.query('UPDATE masters SET marketing_sms=$1, marketing_sms_at=$2 WHERE id=$3', [on, on ? new Date() : null, masterId]);
    const permission = on ? permissionText('marketing', language) : null;
    await consentLog.recordAction({ eventType: on ? 'MARKETING_SMS_OPT_IN' : 'MARKETING_SMS_OPT_OUT', phone: master.phone, masterId,
      metadata: { actor, source, ...(reason ? { reason } : {}) }, meta,
      consentText: permission?.text || null, language: on ? language : null, version: permission?.version || null }, client);
    return { on, changed: true };
  });
  if (result?.changed) await audit.record(masterId, { actor: actor === 'provider' ? 'Исполнитель' : audit.ADMIN, action: on ? 'marketing_on' : 'marketing_off',
    body: on ? 'Включил предложения Xtender' : 'Выключил предложения Xtender' });
  return result ? result.on : null;
}

// Можно ли слать исполнителю рекламу Xtender: только по действующему разрешению. Рассылки рекламы пока нет;
// любая будущая рассылка обязана проверять это перед каждой отправкой.
function canSendMarketing(master) {
  return Boolean(master && master.marketing_sms === true && !master.is_banned);
}

// Есть ли у исполнителя согласие на SMS о заявках на нынешний номер. Прежняя единая отметка (до двух разрешений)
// включала сообщения о заявках, поэтому она считается; новая регистрация — только с отмеченной «заявки по SMS»;
// включение с показанным текстом (кабинет, страница заявки) — тоже. Включение администратором согласием не является.
async function hasLeadConsent(masterId, client = pool) {
  const master = (await client.query('SELECT phone FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master) return false;
  const variants = require('../config/phone').phoneVariants(master.phone);
  if (!variants.length) return false;
  const ph = variants.map((_, i) => `$${i + 1}`).join(', ');
  const rows = (await client.query(`SELECT event_type, metadata, consent_text_snapshot FROM sms_consent_logs
    WHERE event_type IN ('CONSENT_SMS_OTP_VERIFIED', 'LEAD_SMS_OPT_IN') AND phone_number IN (${ph})`, variants)).rows;
  return rows.some((row) => {
    if (row.event_type === 'LEAD_SMS_OPT_IN') return Boolean(row.consent_text_snapshot);
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    const choices = metadata?.snapshot?.choices;
    return !choices || choices.lead_sms === true;
  });
}

module.exports = { permissionText, applyRegistration, setMarketing, canSendMarketing, hasLeadConsent };
