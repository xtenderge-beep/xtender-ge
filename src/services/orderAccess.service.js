// Право исполнителя на заявку (решение 3 владельца): даётся, когда модератор включил исполнителя в рассылку, и хранится
// в order_access отдельно от доставки SMS — сбой SMS прав не меняет. Прежние заявки: доступ и по строке lead_charge.
const pool = require('../config/db');

async function grant(orderId, masterId, { source = 'dispatch', runId = null } = {}, client = pool) {
  await client.query('INSERT INTO order_access (order_id, master_id, source, run_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [orderId, masterId, source, runId]);
}

async function has(orderId, masterId, client = pool) {
  if (!orderId || !masterId) return false;
  const row = (await client.query('SELECT 1 FROM order_access WHERE order_id=$1 AND master_id=$2', [orderId, masterId])).rows[0];
  if (row) return true;
  return Boolean((await client.query("SELECT 1 FROM balance_transactions WHERE order_id=$1 AND master_id=$2 AND reason='lead_charge' LIMIT 1", [orderId, masterId])).rows[0]);
}

// Заявки исполнителя с доступом (для поиска «доступных заявок» в API), новые сверху.
async function orderIdsFor(masterId, client = pool) {
  const rows = (await client.query(
    `SELECT order_id FROM order_access WHERE master_id=$1
     UNION SELECT order_id FROM balance_transactions WHERE master_id=$1 AND reason='lead_charge' AND order_id IS NOT NULL`, [masterId])).rows;
  return rows.map((row) => row.order_id);
}

module.exports = { grant, has, orderIdsFor };
