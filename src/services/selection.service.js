// Выбор предложения заказчиком и подтверждение исполнителем (ТЗ, раздел 8). Выбор в одной транзакции проверяет владельца,
// версии заявки и предложения, статус и срок действия, закрывает сбор и создаёт запись выбора; второй одновременный выбор
// падает на уникальном active_key (409). Выбор фиксирует намерение: денег не списывает и договором не является.
// Подтверждение — до confirm_by (24 часа, но раньше начала работ); отказ или истечение возвращают заявку к выбору другого.
const crypto = require('node:crypto');
const pool = require('../config/db');
const deal = require('../config/deal');
const tenders = require('./tender.service');
const offers = require('./offer.service');
const outbox = require('./outbox.service');
const consentLog = require('./consentLog.service');

const { DealError, HOUR } = deal;
const newId = () => 'sel_' + crypto.randomBytes(10).toString('hex');

function confirmBy(order, now = new Date()) {
  let at = now.getTime() + deal.CONFIRM_HOURS * HOUR;
  if (order.requested_start_at) at = Math.min(at, new Date(order.requested_start_at).getTime() - deal.START_MARGIN_HOURS.confirmation * HOUR);
  return new Date(Math.max(at, now.getTime() + 15 * 60 * 1000));
}

// expected.offerVersion и expected.tenderVersion обязательны: выбор только той версии, которую видел заказчик.
async function select(orderId, { offerId, offerVersion, tenderVersion, actor = 'customer', meta = {} }, now = new Date()) {
  if (offerVersion === undefined || tenderVersion === undefined) {
    throw new DealError(422, 'VALIDATION_FAILED', 'expected_offer_version and expected_tender_version are required.', { fields: [{ path: 'expected_offer_version', code: 'REQUIRED' }] });
  }
  try {
    return await pool.withTransaction(async (client) => {
      const order = await tenders.lockById(client, orderId);
      if (!order) throw tenders.notFound();
      tenders.checkVersion(order, tenderVersion);
      const current = tenders.status(order, now);
      if (!['offers', 'both'].includes(order.response_mode)) throw new DealError(409, 'ACTION_NOT_ALLOWED', 'This request does not take written offers.');
      if (!['open', 'closed'].includes(current)) throw new DealError(409, current === 'selection_pending' ? 'SELECTION_EXISTS' : 'ACTION_NOT_ALLOWED', `Selection is not possible while the request is ${current}.`);
      const offer = await offers.lock(client, offerId);
      if (!offer || offer.order_id !== order.id) throw new DealError(404, 'NOT_FOUND', 'The offer does not exist for this request.');
      offers.checkVersion(offer, offerVersion);
      if (offer.status !== 'submitted') throw new DealError(409, 'OFFER_NOT_AVAILABLE', `The offer is ${offer.status}; only a submitted offer can be chosen.`);
      if (offer.valid_until && new Date(offer.valid_until) <= now) throw new DealError(409, 'OFFER_EXPIRED', 'The offer has expired.');
      const master = (await client.query('SELECT id, is_active, is_banned FROM masters WHERE id=$1', [offer.master_id])).rows[0];
      if (!master || !master.is_active || master.is_banned) throw new DealError(409, 'OFFER_NOT_AVAILABLE', 'The provider is not active.');
      const selection = (await client.query(
        `INSERT INTO order_selections (id, order_id, offer_id, offer_version, master_id, status, active_key, confirm_by)
         VALUES ($1,$2,$3,$4,$5,'pending',$2,$6) RETURNING *`, [newId(), order.id, offer.id, offer.version, offer.master_id, confirmBy(order, now)])).rows[0];
      await client.query("UPDATE offers SET status='selected', updated_at=NOW() WHERE id=$1", [offer.id]);
      await client.query(`UPDATE orders SET deal_status='selection_pending', collection_closed_at=COALESCE(collection_closed_at, $2),
        api_version=api_version+1, deal_updated_at=NOW() WHERE id=$1`, [order.id, now]);
      await consentLog.recordAction({ eventType: 'ORDER_OFFER_SELECTED', phone: order.phone, orderId: order.id, masterId: offer.master_id,
        metadata: { selection_id: selection.id, offer_id: offer.id, offer_version: offer.version, total_amount_minor: offer.data?.total_amount_minor ?? null, actor }, meta }, client);
      await outbox.emit(client, 'selection.created', order.id, { selection_id: selection.id, offer_id: offer.id, master_id: offer.master_id }, `selection.created:${selection.id}`);
      return selection;
    });
  } catch (error) {
    // Второй одновременный выбор: уникальный active_key уже занят первым.
    if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
      throw new DealError(409, 'SELECTION_EXISTS', 'Another offer was chosen for this request at the same time. Read the request again.');
    }
    throw error;
  }
}

async function lockPending(client, master, offerId) {
  const selection = (await client.query("SELECT * FROM order_selections WHERE offer_id=$1 AND active_key IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [offerId])).rows[0];
  if (!selection || selection.master_id !== master.id) throw new DealError(404, 'NOT_FOUND', 'There is no selection of this offer for you.');
  return selection;
}

async function accept(master, offerId, { meta = {} } = {}, now = new Date()) {
  return pool.withTransaction(async (client) => {
    const selection = await lockPending(client, master, offerId);
    if (selection.status === 'accepted') return selection;
    if (selection.status !== 'pending') throw new DealError(409, 'ACTION_NOT_ALLOWED', `The selection is ${selection.status}.`);
    if (new Date(selection.confirm_by) <= now) throw new DealError(409, 'SELECTION_EXPIRED', 'The time to confirm has passed.');
    const order = await tenders.lockById(client, selection.order_id);
    const updated = (await client.query("UPDATE order_selections SET status='accepted', decided_at=NOW() WHERE id=$1 RETURNING *", [selection.id])).rows[0];
    await client.query("UPDATE offers SET status='accepted', updated_at=NOW() WHERE id=$1", [selection.offer_id]);
    // Остальные действующие предложения — «не выбраны» только теперь, после подтверждения выбранным исполнителем.
    await client.query("UPDATE offers SET status='not_selected', updated_at=NOW() WHERE order_id=$1 AND id<>$2 AND status='submitted'", [order.id, selection.offer_id]);
    await client.query("UPDATE orders SET deal_status='awarded', api_version=api_version+1, deal_updated_at=NOW() WHERE id=$1", [order.id]);
    // Телефон заказчика открывается исполнителю — в журнал, как выдача контакта со страницы заявки.
    await consentLog.recordAction({ eventType: 'ORDER_CONTACT_RELEASED', phone: order.phone, orderId: order.id, masterId: master.id,
      metadata: { channel: 'selection', access: 'selection_accepted', selection_id: selection.id, response_mode: order.response_mode }, meta }, client);
    await outbox.emit(client, 'selection.accepted', order.id, { selection_id: selection.id, offer_id: selection.offer_id }, `selection.accepted:${selection.id}`);
    return updated;
  });
}

async function finishPending(client, selection, status, reason = null) {
  await client.query('UPDATE order_selections SET status=$2, active_key=NULL, decided_at=NOW(), decline_reason=$3 WHERE id=$1', [selection.id, status, reason]);
  await client.query('UPDATE offers SET status=$2, updated_at=NOW() WHERE id=$1', [selection.offer_id, status === 'declined' ? 'declined' : 'expired']);
  // Сбор остаётся закрытым; заявка снова доступна для выбора другого действующего предложения.
  await client.query("UPDATE orders SET deal_status='open', api_version=api_version+1, deal_updated_at=NOW() WHERE id=$1 AND deal_status='selection_pending'", [selection.order_id]);
  await outbox.emit(client, 'selection.' + status, selection.order_id, { selection_id: selection.id, offer_id: selection.offer_id }, `selection.${status}:${selection.id}`);
}

async function decline(master, offerId, reason) {
  const why = typeof reason === 'string' ? reason.trim().slice(0, deal.LIMITS.reason) : '';
  if (why.length < 3) throw new DealError(422, 'VALIDATION_FAILED', 'A reason is required.', { fields: [{ path: 'reason', code: 'REQUIRED' }] });
  return pool.withTransaction(async (client) => {
    const selection = await lockPending(client, master, offerId);
    if (selection.status !== 'pending') throw new DealError(409, 'ACTION_NOT_ALLOWED', `The selection is ${selection.status}.`);
    await finishPending(client, selection, 'declined', why);
    return (await client.query('SELECT * FROM order_selections WHERE id=$1', [selection.id])).rows[0];
  });
}

async function expireDue(now = new Date()) {
  const due = (await pool.query("SELECT id FROM order_selections WHERE status='pending' AND confirm_by <= $1", [now])).rows;
  for (const row of due) {
    await pool.withTransaction(async (client) => {
      const selection = (await client.query('SELECT * FROM order_selections WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
      if (!selection || selection.status !== 'pending' || new Date(selection.confirm_by) > now) return;
      await finishPending(client, selection, 'expired');
    });
  }
  return due.length;
}

async function latest(orderId, client = pool) {
  return (await client.query('SELECT * FROM order_selections WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [orderId])).rows[0] || null;
}

function view(selection) {
  if (!selection) return null;
  return { id: selection.id, tender_id: 'tnd_' + selection.order_id, offer_id: selection.offer_id, offer_version: selection.offer_version, status: selection.status,
    confirm_by: deal.iso(selection.confirm_by), decline_reason: selection.decline_reason || null, created_at: deal.iso(selection.created_at), decided_at: deal.iso(selection.decided_at) };
}

module.exports = { select, accept, decline, expireDue, latest, view, confirmBy };
