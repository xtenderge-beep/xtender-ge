const pool = require('../config/db');

// A customer contact event also has master_id. It must never turn a customer
// phone lookup into an export of an unrelated provider's entire financial history.
const IDENTITY_EVENTS = new Set(['MASTER_REGISTERED', 'MASTER_DELETED', 'PROVIDER_BILLING_ACCEPTED']);
async function collect(profiles, phoneEvents) {
  const ids = [...new Set([...profiles.map(p => p.id), ...phoneEvents
    .filter(e => IDENTITY_EVENTS.has(e.event_type) && e.master_id).map(e => e.master_id)])];
  if (!ids.length) return null;
  const ph = ids.map((_, i) => '$' + (i + 1)).join(',');
  const [transactions, deliveries, events, acceptances] = await Promise.all([
    pool.query(`SELECT id,master_id,order_id,amount_tetri,reason,note,created_at FROM balance_transactions WHERE master_id IN (${ph}) ORDER BY created_at,id`, ids),
    pool.query(`SELECT id,run_id,order_id,master_id,status,created_at,finished_at FROM dispatch_deliveries WHERE master_id IN (${ph}) ORDER BY created_at,id`, ids),
    pool.query(`SELECT * FROM sms_consent_logs WHERE master_id IN (${ph}) ORDER BY timestamp_utc,id`, ids),
    pool.query(`SELECT master_id,pricing_key,consent_log_id,accepted_at FROM master_billing_acceptances WHERE master_id IN (${ph})`, ids),
  ]);
  const orderIds = [...new Set([...transactions.rows, ...deliveries.rows, ...events.rows].map(row => row.order_id).filter(Boolean))];
  let orders = [], closures = [], orderEvents = [];
  if (orderIds.length) {
    const oph = orderIds.map((_, i) => '$' + (i + 1)).join(',');
    const results = await Promise.all([
      pool.query(`SELECT id,phone,description,status,created_at,closed_at,closed_by,closing_reason,target_categories FROM orders WHERE id IN (${oph}) ORDER BY id`, orderIds),
      pool.query(`SELECT order_id,category,closed_at,closed_by,reason FROM order_category_closures WHERE order_id IN (${oph}) ORDER BY order_id,category`, orderIds),
      pool.query(`SELECT * FROM sms_consent_logs WHERE order_id IN (${oph}) AND event_type IN ('ORDER_PUBLISHED','ORDER_DETAILS_RECORDED','ORDER_CLOSED','ORDER_CATEGORY_CLOSED','CONTACT_SHARING_WITHDRAWN','CLIENT_CONSENT_OTP_VERIFIED') ORDER BY timestamp_utc,id`, orderIds),
    ]);
    [orders, closures, orderEvents] = results.map(result => result.rows);
  }
  return {
    master_ids: ids,
    notes: [
      'Gateway acceptance does not prove handset delivery or that a notification was read.',
      'Contact release does not prove a call, a reply or a completed job.',
      'current_orders and current_acceptances describe export-time state; historical snapshots are in audit events.',
      'Missing historical evidence is not reconstructed or inferred. Deleted rows may remain available only through audit events.',
    ],
    current_acceptances: acceptances.rows,
    billing_acceptance_events: events.rows.filter(e => e.event_type === 'PROVIDER_BILLING_ACCEPTED'),
    transactions: transactions.rows, deliveries: deliveries.rows,
    charge_events: events.rows.filter(e => ['LEAD_CHARGE_ACCEPTED','CATALOG_CHARGE_ACCEPTED'].includes(e.event_type)),
    contact_events: events.rows.filter(e => ['ORDER_CONTACT_RELEASED','ORDER_CONTACT_DENIED'].includes(e.event_type)),
    current_orders: orders, category_closures: closures,
    timeline: [...new Map([...phoneEvents, ...events.rows, ...orderEvents].map(e => [String(e.id), e])).values()]
      .sort((a,b) => new Date(a.timestamp_utc) - new Date(b.timestamp_utc) || Number(a.id) - Number(b.id)),
  };
}
module.exports = { collect };
