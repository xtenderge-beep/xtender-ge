// Согласие заказчика из ChatGPT (решение 9 владельца): при первой публикации — отдельная страница xtender.ge /consent/<ссылка>
// с теми же текстами, что у формы заявки на сайте (consent.service, роль client), и отдельной галочкой SMS-уведомлений.
// Согласие хранится у аккаунта до смены версии Оферты или Политики. Каждая публикация получает свою строку журнала
// (consent_uses не даёт применить одну строку к двум заявкам), со ссылкой на согласие аккаунта.
const crypto = require('node:crypto');
const pool = require('../config/db');
const redis = require('../config/redis');
const consentLog = require('./consentLog.service');
const legalContent = require('./legalContent.service');
const { getBaseUrl } = require('../config/url');

const LINK_TTL_SECONDS = 30 * 60;
const NOTIFY_TEXT_VERSION = 'notify-v1-2026-10-23';
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

async function state(account) {
  const [terms, privacy] = await Promise.all([legalContent.getTerms(), legalContent.getPrivacy()]);
  return { accepted: account.terms_version_accepted === terms.version && account.privacy_version_accepted === privacy.version,
    termsVersion: terms.version, privacyVersion: privacy.version, notifySms: account.notify_sms === true };
}

async function createLink(account, tenderId) {
  const token = crypto.randomBytes(24).toString('base64url');
  await redis.set('consent_link:' + sha(token), JSON.stringify({ accountId: account.id, tenderId }), 'EX', LINK_TTL_SECONDS);
  return getBaseUrl() + '/consent/' + token;
}

async function readLink(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const raw = await redis.get('consent_link:' + sha(token));
  return raw ? JSON.parse(raw) : null;
}

// Текст согласия на SMS-уведомления — отдельно от Оферты (решение 9): что присылаем и как отключить.
function notifyText(lang) {
  return require('../config/deal-copy').copy(lang)('notify_consent');
}

// Человек отметил галочки на странице. bundle — снимок текстов consent.service.bundle('client', язык).
async function accept(token, { bundle, sms, meta = {} }) {
  const link = await readLink(token);
  if (!link) return null;
  const account = await require('./account.service').getById(link.accountId);
  if (!account || account.status !== 'active') return null;
  return pool.withTransaction(async (client) => {
    const row = await consentLog.recordPageConsent({ eventType: 'CLIENT_CONSENT_ACCOUNT', phone: account.phone, termsVersion: bundle.terms_version,
      language: bundle.language, text: bundle.text,
      metadata: { account_id: account.id, privacy_version: bundle.privacy_version, snapshot_digest: bundle.digest, acceptance_method: 'xtender_consent_page',
        terms_accepted: true, privacy_accepted: true, tender_id: link.tenderId } , meta }, client);
    let notifyRow = null;
    if (sms) {
      notifyRow = await consentLog.recordPageConsent({ eventType: 'NOTIFY_SMS_CONSENT', phone: account.phone, language: bundle.language,
        text: notifyText(bundle.language), metadata: { account_id: account.id, text_version: NOTIFY_TEXT_VERSION, scope: 'account' }, meta }, client);
    }
    await client.query(
      `UPDATE accounts SET terms_version_accepted = $2, privacy_version_accepted = $3, consent_log_id = $4, version = version + 1, updated_at = NOW()
       WHERE id = $1`, [account.id, bundle.terms_version, bundle.privacy_version, row.id]);
    if (notifyRow) await client.query('UPDATE accounts SET notify_sms = true, notify_consent_log_id = $2 WHERE id = $1', [account.id, notifyRow.id]);
    await redis.del('consent_link:' + sha(token));
    return { account, tenderId: link.tenderId };
  });
}

// При публикации: своя строка журнала для этой заявки, связь заявки с согласием (consent_uses → язык страницы
// заказчика) и SMS-уведомления по заявке, если аккаунт на них согласился.
async function applyToOrder(client, account, order, meta = {}) {
  const base = account.consent_log_id ? (await client.query('SELECT * FROM sms_consent_logs WHERE id=$1', [account.consent_log_id])).rows[0] : null;
  const row = await consentLog.recordPageConsent({ eventType: 'CLIENT_CONSENT_ACCOUNT_APPLIED', phone: account.phone, termsVersion: account.terms_version_accepted,
    language: base?.consent_language || account.locale, text: base?.consent_text_snapshot || null,
    metadata: { account_id: account.id, account_consent_log_id: account.consent_log_id, privacy_version: account.privacy_version_accepted, channel: order.channel }, meta }, client);
  await consentLog.applyConsent({ consentLogId: row.id, snapshot: { digest: base?.metadata?.snapshot_digest || null } }, 'client', order.id, account.phone, meta, client);
  if (account.notify_sms && account.notify_consent_log_id) {
    await client.query(
      `INSERT INTO order_notifications (order_id, sms_enabled, rules, consent_log_id) VALUES ($1, true, $2::jsonb, $3)
       ON CONFLICT (order_id) DO NOTHING`,
      [order.id, JSON.stringify(require('./dealNotify.service').DEFAULT_RULES), account.notify_consent_log_id]);
  }
}

module.exports = { state, createLink, readLink, accept, applyToOrder, notifyText, NOTIFY_TEXT_VERSION, LINK_TTL_SECONDS };
