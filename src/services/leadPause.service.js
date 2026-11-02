const pool = require('../config/db');
const consentLog = require('./consentLog.service');
const audit = require('./masterAudit.service');

// Пауза SMS о заявках: исполнитель не открыл две последние заявки, пришедшие ему по SMS. Так меньше SMS
// уходит впустую и меньше риск писать человеку, к которому перешёл номер. Пауза не доказывает, что номер
// сменил владельца: это мера экономии и осторожности. Снять её можно только новым кодом на номер
// (кабинет → «Получить код»), не старой ссылкой: её мог открыть и новый владелец.
// Не считаем: заявки моложе двух часов (дать время открыть), заявки в Telegram (не привязаны к номеру),
// заявки, которые не открыл никто из получателей (похоже на сбой доставки, а не на чужой номер).
const OPEN_WINDOW_MS = 2 * 60 * 60 * 1000;
const UNOPENED_LIMIT = 2;

function isPaused(master) {
  return Boolean(master && master.lead_sms_paused_at && !master.telegram_id);
}

async function openedBy(orderIds, client) {
  const ph = orderIds.map((_, i) => `$${i + 1}`).join(', ');
  const [links, views] = await Promise.all([
    client.query(`SELECT order_id, master_id FROM lead_links WHERE bound_at IS NOT NULL AND order_id IN (${ph})`, orderIds),
    client.query(`SELECT order_id, master_id FROM order_views WHERE order_id IN (${ph})`, orderIds),
  ]);
  const opened = new Map();
  for (const row of [...links.rows, ...views.rows]) {
    const id = Number(row.order_id);
    if (!opened.has(id)) opened.set(id, new Set());
    opened.get(id).add(Number(row.master_id));
  }
  return opened;
}

// Перед SMS о новой заявке: уже на паузе или пора поставить. Вызывается внутри транзакции отправки.
async function check(master, client = pool) {
  if (master.telegram_id) return { paused: false };
  if (master.lead_sms_paused_at) return { paused: true, justPaused: false };
  const cutoff = new Date(Date.now() - OPEN_WINDOW_MS);
  const since = master.lead_sms_resumed_at ? new Date(master.lead_sms_resumed_at) : new Date(0);
  const recent = (await client.query(`SELECT order_id, finished_at FROM dispatch_deliveries
    WHERE master_id=$1 AND status='accepted' AND channel='sms' AND finished_at < $2 AND finished_at > $3
    ORDER BY finished_at DESC, id DESC LIMIT 10`, [master.id, cutoff, since])).rows;
  const orders = [...new Set(recent.map((row) => Number(row.order_id)))].slice(0, UNOPENED_LIMIT);
  if (orders.length < UNOPENED_LIMIT) return { paused: false };
  const opened = await openedBy(orders, client);
  if (orders.some((id) => !opened.has(id))) return { paused: false };
  if (orders.some((id) => opened.get(id).has(Number(master.id)))) return { paused: false };
  await client.query('UPDATE masters SET lead_sms_paused_at=NOW() WHERE id=$1', [master.id]);
  await consentLog.recordAction({ eventType: 'LEAD_SMS_PAUSED', phone: master.phone, masterId: master.id,
    metadata: { rule: 'two_unopened_sms_leads', unopened_order_ids: orders } }, client);
  return { paused: true, justPaused: true, orders };
}

// Код на номер подтверждён в кабинете: снимаем паузу; отсчёт неоткрытых начинается заново.
async function resume(masterId, { meta = {} } = {}) {
  const result = await pool.withTransaction(async (client) => {
    const master = (await client.query('SELECT id, phone, lead_sms_paused_at FROM masters WHERE id=$1 FOR UPDATE', [masterId])).rows[0];
    if (!master) return null;
    if (!master.lead_sms_paused_at) return { resumed: false };
    await client.query('UPDATE masters SET lead_sms_paused_at=NULL, lead_sms_resumed_at=NOW() WHERE id=$1', [masterId]);
    await consentLog.recordAction({ eventType: 'LEAD_SMS_RESUMED', phone: master.phone, masterId,
      metadata: { actor: 'provider', via: 'sms_code' }, meta }, client);
    return { resumed: true };
  });
  if (result?.resumed) await audit.record(masterId, { actor: 'Исполнитель', action: 'lead_sms_resumed', body: 'Снял паузу SMS о заявках, подтвердив номер кодом' });
  return result;
}

module.exports = { OPEN_WINDOW_MS, UNOPENED_LIMIT, isPaused, check, resume };
