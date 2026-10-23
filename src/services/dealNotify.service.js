// Уведомления участникам сделки по событиям очереди (outbox) — docs/api-v1/NOTIFICATIONS.md.
// Заказчику — SMS, только с отдельным согласием (order_notifications.consent_log_id) и только по включённым правилам.
// По умолчанию (решение 8): первое предложение и завершение сбора; вопрос исполнителя и ответ на выбор — по желанию.
// Исполнителю (выбор его предложения, ответ заказчика) — Telegram, если привязан, иначе SMS (согласие на сервисные
// уведомления дано при регистрации). Каждое уведомление — строка notification_deliveries с уникальным dedupe_key: повтор
// события второй SMS не создаёт. Тихие часы заказчика 22:00–09:00 по Тбилиси, не больше 8 SMS на номер в сутки.
const pool = require('../config/db');
const deal = require('../config/deal');
const serviceMessage = require('../config/service-message-copy');
const dealCopy = require('../config/deal-copy');
const { getBaseUrl } = require('../config/url');

const DEFAULT_RULES = { first_offer: true, collection_closed: true, new_question: false, selection_changed: false };
const RULES = Object.keys(DEFAULT_RULES);
const DAILY_SMS_LIMIT = 8;
const MAX_SEND_ATTEMPTS = 4;
const RETRY_MS = [60, 300, 900].map((s) => s * 1000);
const THROTTLE_MS = 60 * 60 * 1000;

// --- Настройки заказчика -------------------------------------------------------------------------------------------
async function settings(orderId, client = pool) {
  const row = (await client.query('SELECT * FROM order_notifications WHERE order_id=$1', [orderId])).rows[0];
  return row ? { ...row, rules: { ...DEFAULT_RULES, ...(row.rules || {}) } } : { order_id: orderId, sms_enabled: false, rules: { ...DEFAULT_RULES }, consent_log_id: null };
}

// Включение SMS — с записью согласия (текст, версия, язык, источник); выключение — с записью отказа. rules — частично.
async function setSettings(order, { smsEnabled, rules, language = 'ru', source = 'site', meta = {}, consentAccepted = false, accountConsentLogId = null }) {
  const consentLog = require('./consentLog.service');
  const { NOTIFY_TEXT_VERSION, notifyText } = require('./accountConsent.service');
  const { DealError } = deal;
  if (rules !== undefined && (typeof rules !== 'object' || Array.isArray(rules) || Object.entries(rules).some(([k, v]) => !RULES.includes(k) || typeof v !== 'boolean'))) {
    throw new DealError(422, 'VALIDATION_FAILED', 'rules: ' + RULES.join(', ') + ' with true or false.', { fields: [{ path: 'rules', code: 'INVALID_VALUE' }] });
  }
  return pool.withTransaction(async (client) => {
    const current = await settings(order.id, client);
    let consentId = current.consent_log_id;
    if (smsEnabled === true && !current.sms_enabled) {
      if (!consentId && accountConsentLogId) consentId = accountConsentLogId;
      if (!consentId) {
        if (!consentAccepted) throw new DealError(422, 'CONSENT_REQUIRED', 'SMS notifications need the customer’s consent.', { fields: [{ path: 'consent', code: 'REQUIRED' }] });
        consentId = (await consentLog.recordPageConsent({ eventType: 'NOTIFY_SMS_CONSENT', phone: order.phone, language, text: notifyText(language), orderId: order.id,
          metadata: { order_id: order.id, text_version: NOTIFY_TEXT_VERSION, scope: 'order', source, acceptance_method: source === 'api' ? 'ai_agent_reported' : 'checkbox' }, meta }, client)).id;
      }
    }
    if (smsEnabled === false && current.sms_enabled) {
      await consentLog.recordAction({ eventType: 'NOTIFY_SMS_OPT_OUT', phone: order.phone, orderId: order.id, metadata: { source }, meta }, client);
      await client.query("UPDATE notification_deliveries SET status='cancelled', error_code='opted_out' WHERE order_id=$1 AND recipient_role='customer' AND status='queued'", [order.id]);
    }
    const enabled = smsEnabled === undefined ? current.sms_enabled : smsEnabled === true;
    const merged = { ...current.rules, ...(rules || {}) };
    await client.query(
      `INSERT INTO order_notifications (order_id, sms_enabled, rules, consent_log_id, updated_at) VALUES ($1,$2,$3::jsonb,$4,NOW())
       ON CONFLICT (order_id) DO UPDATE SET sms_enabled=EXCLUDED.sms_enabled, rules=EXCLUDED.rules, consent_log_id=EXCLUDED.consent_log_id, updated_at=NOW()`,
      [order.id, enabled, JSON.stringify(merged), consentId]);
    return settings(order.id, client);
  });
}

// --- Время отправки --------------------------------------------------------------------------------------------------
function localMinutes(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
    .map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
const toMinutes = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null; };

// В тихие часы — отложить до их конца. from > to — окно через полночь (22:00–09:00).
function afterQuietHours(now, from = '22:00', to = '09:00', timeZone = 'Asia/Tbilisi') {
  const start = toMinutes(from), end = toMinutes(to);
  if (start === null || end === null || start === end) return now;
  const minute = localMinutes(now, timeZone);
  const inside = start > end ? minute >= start || minute < end : minute >= start && minute < end;
  if (!inside) return now;
  const wait = (end - minute + 1440) % 1440;
  return new Date(now.getTime() + wait * 60 * 1000 - now.getSeconds() * 1000);
}

// --- Постановка в очередь --------------------------------------------------------------------------------------------
async function queue({ event, order, role, ref, channel, rule, dedupe, body, sendAfter = new Date() }) {
  const row = (await pool.query(
    `INSERT INTO notification_deliveries (event_id, order_id, recipient_role, recipient_ref, channel, rule, dedupe_key, body, send_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [event?.id || null, order.id, role, ref, channel, rule, dedupe, body, sendAfter])).rows[0];
  return row ? row.id : null;
}

async function customerSms(event, order, rule, key, values, dedupe, now) {
  if (order.status === 'unverified') return null;
  const prefs = await settings(order.id);
  if (!prefs.sms_enabled || !prefs.consent_log_id || !prefs.rules[rule]) return null;
  const link = (await require('./resumeLink.service').create(order.id)).url;
  const account = order.account_id ? await require('./account.service').getById(order.account_id) : null;
  const sendAfter = afterQuietHours(now, account?.quiet_from || '22:00', account?.quiet_to || '09:00', order.timezone || 'Asia/Tbilisi');
  return queue({ event, order, role: 'customer', ref: 'order:' + order.id, channel: 'sms', rule, dedupe, body: serviceMessage.sms(key, { id: order.id, link, ...values }), sendAfter });
}

async function providerNotice(event, order, masterId, rule, { smsKey, tgKey, values = {} }, dedupe) {
  const master = (await pool.query('SELECT id, phone, telegram_id, language, is_banned FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master || master.is_banned) return null;
  const link = getBaseUrl() + '/order/' + order.token;
  const channel = master.telegram_id ? 'telegram' : 'sms';
  const body = channel === 'telegram'
    ? dealCopy.copy(master.language || 'ru')(tgKey, { id: order.id, link, ...values })
    : serviceMessage.sms(smsKey, { id: order.id, link, ...values });
  return queue({ event, order, role: 'provider', ref: 'master:' + master.id, channel, rule, dedupe, body });
}

// Срок подтверждения в SMS — латиницей и по Тбилиси: «18:30 24.10».
function shortTime(date, timeZone = 'Asia/Tbilisi') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}.${p.month}`;
}

// --- Обработка событий -----------------------------------------------------------------------------------------------
async function handle(event, now = new Date()) {
  const order = event.order_id ? (await pool.query('SELECT * FROM orders WHERE id=$1', [event.order_id])).rows[0] : null;
  if (!order) return;
  const p = event.payload || {};
  switch (event.event_type) {
    case 'offer.submitted': {
      // Порог «первое предложение» — по уникальным исполнителям, одна SMS на заявку. Если сбор уже закрыт, SMS о закрытии
      // скажет обо всех предложениях сразу.
      if (!p.first || order.collection_closed_at) return;
      await customerSms(event, order, 'first_offer', 'dealFirstOffer', {}, `first_offer:${order.id}`, now);
      return;
    }
    case 'tender.collection_closed': {
      if (['selection_pending', 'awarded', 'completed', 'cancelled'].includes(order.deal_status)) return;
      const count = (await pool.query("SELECT COUNT(*)::int AS n FROM offers WHERE order_id=$1 AND status IN ('submitted','selected','accepted')", [order.id])).rows[0].n;
      // Совпали события: если SMS о первом предложении ещё не ушла — вместо двух сообщений одно.
      await pool.query("UPDATE notification_deliveries SET status='cancelled', error_code='merged' WHERE dedupe_key=$1 AND status='queued'", [`first_offer:${order.id}`]);
      await customerSms(event, order, 'collection_closed', count ? 'dealCollectionClosed' : 'dealCollectionClosedNone', { n: count }, `collection_closed:${order.id}`, now);
      return;
    }
    case 'message.created': {
      const bucket = Math.floor(now.getTime() / THROTTLE_MS);
      if (p.author_role === 'provider') {
        await customerSms(event, order, 'new_question', 'dealNewQuestion', {}, `new_question:${p.thread_id}:${bucket}`, now);
      } else if (p.master_id) {
        await providerNotice(event, order, p.master_id, 'customer_reply', { smsKey: 'dealProviderReply', tgKey: 'tg_reply' }, `customer_reply:${p.thread_id}:${bucket}`);
      }
      return;
    }
    case 'selection.created': {
      const selection = (await pool.query('SELECT * FROM order_selections WHERE id=$1', [p.selection_id])).rows[0];
      if (!selection) return;
      const time = shortTime(selection.confirm_by, order.timezone || 'Asia/Tbilisi');
      await providerNotice(event, order, selection.master_id, 'selected', { smsKey: 'dealProviderSelected', tgKey: 'tg_selected', values: { time } }, `selected:${selection.id}`);
      return;
    }
    case 'selection.accepted':
    case 'selection.declined':
    case 'selection.expired': {
      const status = event.event_type.split('.')[1];
      const key = { accepted: 'dealSelectionAccepted', declined: 'dealSelectionDeclined', expired: 'dealSelectionExpired' }[status];
      await customerSms(event, order, 'selection_changed', key, {}, `selection_changed:${p.selection_id}:${status}`, now);
      return;
    }
    default:
      // tender.published, offer.updated/withdrawn/expired, tender.cancelled/completed — только журнал событий.
  }
}

// --- Отправка --------------------------------------------------------------------------------------------------------
async function claimDue(now = new Date(), limit = 20) {
  const { rows } = await pool.query(
    `UPDATE notification_deliveries SET status='sending', attempts=attempts+1, send_after=$1
     WHERE id IN (SELECT id FROM notification_deliveries WHERE status='queued' AND send_after <= $1 ORDER BY id LIMIT ${Number(limit)})
       AND status='queued' RETURNING *`, [now]);
  return rows;
}

async function mark(id, status, extra = {}) {
  await pool.query('UPDATE notification_deliveries SET status=$2, provider_message_id=COALESCE($3, provider_message_id), error_code=$4, sent_at=$5, send_after=COALESCE($6, send_after) WHERE id=$1',
    [id, status, extra.providerMessageId || null, extra.errorCode || null, status === 'sent' ? new Date() : null, extra.sendAfter || null]);
}

async function alertOperator(delivery) {
  await require('./telegram.service').sendMessageToModerator(`⚠️ Уведомление по заявке #${delivery.order_id} не отправлено после ${delivery.attempts} попыток (${delivery.rule}, ${delivery.channel}). Смотрите /admin/outbox.`)
    .catch(() => {});
}

async function sendOne(delivery, now) {
  const smsService = require('./sms.service');
  let phone = null;
  if (delivery.recipient_role === 'customer') {
    const order = (await pool.query('SELECT id, phone, status FROM orders WHERE id=$1', [delivery.order_id])).rows[0];
    const prefs = order ? await settings(order.id) : null;
    // Отписка после постановки в очередь: новые сообщения не уходят (ТЗ, раздел 13).
    if (!order || !prefs.sms_enabled || !prefs.rules[delivery.rule]) return mark(delivery.id, 'cancelled', { errorCode: 'opted_out' });
    phone = order.phone;
  } else {
    const master = (await pool.query('SELECT id, phone, telegram_id FROM masters WHERE id=$1', [Number(delivery.recipient_ref.split(':')[1])])).rows[0];
    if (!master) return mark(delivery.id, 'cancelled', { errorCode: 'no_recipient' });
    if (delivery.channel === 'telegram') {
      const receipt = await require('./telegram.service').sendNotice(master.telegram_id, delivery.body).catch(() => ({ ok: false, uncertain: true }));
      if (receipt?.ok) return mark(delivery.id, 'sent', { providerMessageId: receipt.providerMessageId });
      if (receipt?.uncertain) return mark(delivery.id, 'unknown', { errorCode: 'result_unknown' });
      // Бот выключен или отказал — тот же текст SMS исполнителю.
      await pool.query("UPDATE notification_deliveries SET channel='sms' WHERE id=$1", [delivery.id]);
    }
    phone = master.phone;
  }
  const sentToday = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE recipient_ref=$1 AND channel='sms' AND status='sent' AND sent_at >= $2",
    [delivery.recipient_ref, new Date(now.getTime() - 24 * 60 * 60 * 1000)])).rows[0].n;
  if (sentToday >= DAILY_SMS_LIMIT) return mark(delivery.id, 'cancelled', { errorCode: 'daily_limit' });
  try {
    const receipt = await smsService.sendOrderNotification(phone, delivery.body, { kind: 'transactional', orderId: delivery.order_id, deal: true });
    return mark(delivery.id, 'sent', { providerMessageId: receipt?.providerMessageId || null });
  } catch (error) {
    // Ответ шлюза неясен — повтор мог бы задвоить SMS: оставляем «неизвестно» для оператора.
    if (error.deliveryUnknown !== false) return mark(delivery.id, 'unknown', { errorCode: 'result_unknown' });
    if (delivery.attempts >= MAX_SEND_ATTEMPTS) { await mark(delivery.id, 'failed', { errorCode: 'gateway_rejected' }); return alertOperator(delivery); }
    return mark(delivery.id, 'queued', { errorCode: 'gateway_rejected', sendAfter: new Date(now.getTime() + RETRY_MS[Math.min(delivery.attempts - 1, RETRY_MS.length - 1)]) });
  }
}

async function sendDue(now = new Date()) {
  // Отправка прервалась вместе с процессом (sending дольше 10 минут с момента захвата — send_after): неизвестно, ушла ли
  // SMS, — не повторяем, оператор видит статус unknown.
  await pool.query("UPDATE notification_deliveries SET status='unknown', error_code='interrupted' WHERE status='sending' AND send_after < $1",
    [new Date(now.getTime() - 10 * 60 * 1000)]);
  const due = await claimDue(now);
  for (const delivery of due) await sendOne(delivery, now);
  return due.length;
}

async function forOrder(orderId, role = null) {
  const rows = (await pool.query('SELECT * FROM notification_deliveries WHERE order_id=$1 ORDER BY id', [orderId])).rows;
  return role ? rows.filter((r) => r.recipient_role === role) : rows;
}

function deliveryView(row) {
  return { id: String(row.id), rule: row.rule, channel: row.channel, status: row.status, tender_id: row.order_id ? 'tnd_' + row.order_id : null,
    created_at: deal.iso(row.created_at), sent_at: deal.iso(row.sent_at), error_code: row.error_code || null };
}

module.exports = { DEFAULT_RULES, RULES, settings, setSettings, afterQuietHours, handle, sendDue, forOrder, deliveryView, shortTime, DAILY_SMS_LIMIT };
