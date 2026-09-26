const pool = require('../config/db');
const consentLog = require('./consentLog.service');

// The order lock is shared with full/category closure. Audit commits before the
// contact leaves the server; closing cannot race a stale status check.
async function reveal(token, masterToken, channel, meta = {}) {
  if (!masterToken) return { status: 401, code: 'login' };
  if (!['call', 'whatsapp'].includes(channel)) return { status: 400, code: 'invalid' };
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT * FROM masters WHERE master_token=$1 FOR UPDATE', [masterToken])).rows[0];
    if (!master || master.is_banned || !master.is_active) return { status: 403, code: 'forbidden' };
    const order = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE', [token])).rows[0];
    if (!order) return { status: 404, code: 'unavailable' };
    const charged = (await client.query("SELECT id FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge' LIMIT 1", [master.id, order.id])).rows[0];
    // Prefer the category actually sold; flatbed is a dispatch group whose
    // providers store category=transport. Legacy charges have no audit snapshot.
    const sold = charged ? (await client.query("SELECT metadata FROM sms_consent_logs WHERE order_id=$1 AND master_id=$2 AND event_type='LEAD_CHARGE_ACCEPTED' ORDER BY id DESC LIMIT 1", [order.id, master.id])).rows[0] : null;
    const targets = order.target_categories || [];
    const category = sold?.metadata?.category || (master.category === 'transport' && master.is_flatbed && !targets.includes('transport') && targets.includes('flatbed') ? 'flatbed' : master.category);
    const matching = require('./serviceMatching.service');
    const openMatches = await matching.openMatches(master,order,client);
    let code = null;
    if (!charged || master.is_technical !== order.is_technical) code = 'forbidden';
    else if (!['new', 'pending_review'].includes(order.status) || !openMatches.length || !order.phone) code = 'unavailable';
    await consentLog.recordAction({
      eventType: code ? 'ORDER_CONTACT_DENIED' : 'ORDER_CONTACT_RELEASED',
      phone: order.phone, masterId: master.id, orderId: order.id, meta,
      metadata: { channel, category, order_status: order.status, reason: code,
        balance_transaction_id: charged?.id || null },
    }, client);
    if (code) return { status: code === 'forbidden' ? 403 : 409, code };
    await client.query('INSERT INTO order_views (order_id,master_id,event_type) VALUES($1,$2,$3) ON CONFLICT (order_id,master_id,event_type) DO NOTHING', [order.id, master.id, channel]);
    return { status: 200, order };
  });
}

module.exports = { reveal };
