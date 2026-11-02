const pool = require('../config/db');
const settings = require('./settings.service');
const { phoneVariants } = require('../config/phone');

// Заявки по SMS и в Telegram только исполнителям с записью согласия: CONSENT_SMS_OTP_VERIFIED в
// sms_consent_logs (код на /join с показанным текстом согласия). Согласие подтверждает тот, кто
// рассылает (ст. 12(8) закона о персональных данных), поэтому рассылка опирается на запись в журнале.
// Переключатель в /admin/consent, по умолчанию выключен: сначала владелец видит, кого он затронет
// (профили до журнала 2026-09-03, заведённые иначе, номер сменён в админке).
const KEY = 'lead_sms_requires_consent';

async function isRequired() {
  return (await settings.getSetting(KEY, '0')) === '1';
}

async function setRequired(enabled) {
  await settings.setSetting(KEY, enabled ? '1' : '0');
}

async function consentedPhones(client = pool) {
  const { rows } = await client.query("SELECT DISTINCT phone_number FROM sms_consent_logs WHERE event_type = 'CONSENT_SMS_OTP_VERIFIED'");
  return new Set(rows.map((row) => row.phone_number));
}

// В журнале и в профиле один номер может быть записан по-разному: +995…, 995… или 9 цифр.
function covers(phones, phone) {
  return phoneVariants(phone).some((variant) => phones.has(variant));
}

// null — проверка выключена; иначе функция: есть ли запись согласия на номер исполнителя.
async function gate(client = pool) {
  if (!await isRequired()) return null;
  const phones = await consentedPhones(client);
  return (master) => covers(phones, master.phone);
}

// Почему у исполнителя нет записи согласия на его нынешний номер.
const REASONS = {
  phone_changed: 'номер сменён после регистрации с кодом',
  before_journal: 'зарегистрирован до журнала согласий',
  no_code: 'заведён без кода: админка, менеджер или импорт',
};

function reasonFor(master, registeredByCode, journalStart) {
  if (registeredByCode.has(Number(master.id))) return 'phone_changed';
  if (journalStart && new Date(master.created_at) < new Date(journalStart)) return 'before_journal';
  return 'no_code';
}

// Для решения владельца: сколько исполнителей подписаны на заявки, у кого есть запись согласия (по версиям
// показанного текста) и у кого её нет, с причиной. Начало журнала — его первая запись.
async function summary() {
  const [masters, consents, registered, start] = await Promise.all([
    pool.query(`SELECT id, name, phone, created_at, telegram_id, lead_sms_paused_at, marketing_sms FROM masters
      WHERE is_technical = false AND is_active = true AND is_subscribed = true AND is_banned = false ORDER BY id`),
    pool.query("SELECT phone_number, terms_version FROM sms_consent_logs WHERE event_type = 'CONSENT_SMS_OTP_VERIFIED' ORDER BY timestamp_utc, id"),
    // Фильтр master_id IS NOT NULL — в JS: pg-mem на этой таблице теряет строки при таком условии.
    pool.query("SELECT master_id FROM sms_consent_logs WHERE event_type = 'MASTER_REGISTERED'"),
    pool.query('SELECT MIN(timestamp_utc) AS at FROM sms_consent_logs'),
  ]);
  const versionByPhone = new Map(consents.rows.map((row) => [row.phone_number, row.terms_version || '—']));
  const registeredByCode = new Set(registered.rows.filter((row) => row.master_id !== null).map((row) => Number(row.master_id)));
  const journalStart = start.rows[0]?.at || null;
  const versions = new Map(), reasons = { phone_changed: 0, before_journal: 0, no_code: 0 }, missing = [];
  for (const master of masters.rows) {
    const found = phoneVariants(master.phone).find((variant) => versionByPhone.has(variant));
    if (found) {
      const version = versionByPhone.get(found);
      versions.set(version, (versions.get(version) || 0) + 1);
      continue;
    }
    const reason = reasonFor(master, registeredByCode, journalStart);
    reasons[reason] += 1;
    missing.push({ ...master, reason, reasonLabel: REASONS[reason] });
  }
  return {
    required: await isRequired(),
    total: masters.rows.length,
    telegram: masters.rows.filter((master) => master.telegram_id).length,
    paused: masters.rows.filter((master) => master.lead_sms_paused_at && !master.telegram_id).length,
    marketing: masters.rows.filter((master) => master.marketing_sms === true).length,
    consented: masters.rows.length - missing.length,
    versions: [...versions].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    reasons: Object.entries(reasons).filter(([, count]) => count).map(([key, count]) => ({ key, label: REASONS[key], count })),
    journalStart,
    missing,
  };
}

module.exports = { isRequired, setRequired, gate, summary, REASONS };
