const pool = require('../config/db');

const LOW_BALANCE_THRESHOLD_TETRI = 60; // меньше чем на 2 лида по текущей цене

async function getOverviewStats() {
  const [statusCounts, balanceSum, lowBalanceCount, ordersToday, ordersWeek, pendingReviews, responseStats] =
    await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE is_banned = true) AS banned,
           COUNT(*) FILTER (WHERE is_banned = false AND is_active = true) AS active,
           COUNT(*) FILTER (WHERE is_banned = false AND is_active = false) AS pending
         FROM masters`
      ),
      pool.query(`SELECT COALESCE(SUM(balance_tetri), 0) AS total FROM masters WHERE is_banned = false`),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM masters WHERE is_banned = false AND is_active = true AND balance_tetri < $1`,
        [LOW_BALANCE_THRESHOLD_TETRI]
      ),
      // date_trunc() не поддерживается pg-mem (локальная разработка) — считаем полночь в JS.
      pool.query(`SELECT COUNT(*)::int AS count FROM orders WHERE created_at >= $1`, [
        new Date(new Date().setHours(0, 0, 0, 0)),
      ]),
      pool.query(`SELECT COUNT(*)::int AS count FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM master_reviews WHERE is_approved = false`),
      getResponseStats(),
    ]);

  return {
    mastersActive: Number(statusCounts.rows[0].active),
    mastersPending: Number(statusCounts.rows[0].pending),
    mastersBanned: Number(statusCounts.rows[0].banned),
    totalBalanceGel: Number(balanceSum.rows[0].total) / 100,
    lowBalanceCount: lowBalanceCount.rows[0].count,
    ordersToday: ordersToday.rows[0].count,
    ordersThisWeek: ordersWeek.rows[0].count,
    pendingReviewsCount: pendingReviews.rows[0].count,
    responseStats,
  };
}

// Время реакции считается через balance_transactions (reason='lead_charge'): каждая такая
// строка фиксирует "мастер X был уведомлён о заявке Y в момент T" (это единственное место,
// где такая связь вообще хранится — order_dispatches знает только категорию, не мастеров).
// Ищем самое раннее view/call от этого мастера по этой же заявке после списания.
// Без LATERAL — через производную таблицу, pg-mem (локальная разработка) не поддерживает
// коррелированные подзапросы.
async function getResponseStats(masterId = null) {
  const params = [];
  let filter = '';
  if (masterId) {
    params.push(masterId);
    filter = `AND bt.master_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM responded_at) - EXTRACT(EPOCH FROM notified_at)) AS avg_seconds,
            COUNT(responded_at)::int AS responded_count,
            COUNT(*)::int AS total_count
     FROM (
       SELECT bt.order_id, bt.master_id, bt.created_at AS notified_at, MIN(ov.viewed_at) AS responded_at
       FROM balance_transactions bt
       LEFT JOIN order_views ov
         ON ov.order_id = bt.order_id AND ov.master_id = bt.master_id AND ov.event_type IN ('view', 'call')
       WHERE bt.reason = 'lead_charge' ${filter}
       GROUP BY bt.order_id, bt.master_id, bt.created_at
     ) sub`,
    params
  );
  const row = rows[0];
  return {
    avgSeconds: row.avg_seconds === null ? null : Number(row.avg_seconds),
    respondedCount: row.responded_count,
    totalCount: row.total_count,
  };
}

async function listMastersAdmin() {
  // last_topup_at через JOIN с производной таблицей, а не коррелированный подзапрос —
  // pg-mem (локальная разработка) коррелированные подзапросы не поддерживает.
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.is_active, m.is_banned,
            m.banned_reason, m.balance_tetri, m.created_at, lt.last_topup_at,
            COALESCE(AVG(r.rating)::numeric(3,2), 0) AS rating,
            COUNT(r.id)::int AS review_count
     FROM masters m
     LEFT JOIN master_reviews r ON r.master_id = m.id AND r.is_approved = true
     LEFT JOIN (
       SELECT master_id, MAX(created_at) AS last_topup_at
       FROM balance_transactions WHERE reason = 'topup' GROUP BY master_id
     ) lt ON lt.master_id = m.id
     GROUP BY m.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.is_active, m.is_banned,
              m.banned_reason, m.balance_tetri, m.created_at, lt.last_topup_at
     ORDER BY m.id`
  );
  return rows;
}

async function getMasterDetail(id) {
  const { rows } = await pool.query('SELECT * FROM masters WHERE id = $1', [id]);
  const master = rows[0];
  if (!master) return null;

  const { rows: reviewRows } = await pool.query(
    `SELECT COALESCE(AVG(rating)::numeric(3,2), 0) AS computed_rating, COUNT(*)::int AS review_count
     FROM master_reviews WHERE master_id = $1 AND is_approved = true`,
    [id]
  );
  return { ...master, computed_rating: reviewRows[0].computed_rating, review_count: reviewRows[0].review_count };
}

async function getMasterBalanceHistory(masterId) {
  const { rows } = await pool.query(
    `SELECT id, amount_tetri, reason, note, order_id, created_at
     FROM balance_transactions WHERE master_id = $1 ORDER BY created_at DESC`,
    [masterId]
  );
  return rows;
}

async function setMasterBanned(id, banned, reason) {
  await pool.query(
    `UPDATE masters SET is_banned = $1, banned_reason = $2, banned_at = CASE WHEN $1 THEN NOW() ELSE NULL END
     WHERE id = $3`,
    [banned, reason, id]
  );
}

async function listOrdersAdmin() {
  const { rows } = await pool.query(
    `SELECT o.id, o.token, o.description, o.status, o.target_categories, o.created_at,
            o.first_dispatched_at, o.closed_at,
            COUNT(*) FILTER (WHERE ov.event_type = 'view')::int AS view_count,
            COUNT(*) FILTER (WHERE ov.event_type = 'call')::int AS call_count,
            COUNT(*) FILTER (WHERE ov.event_type = 'whatsapp')::int AS whatsapp_count
     FROM orders o
     LEFT JOIN order_views ov ON ov.order_id = o.id
     GROUP BY o.id, o.token, o.description, o.status, o.target_categories, o.created_at,
              o.first_dispatched_at, o.closed_at
     ORDER BY o.created_at DESC`
  );
  return rows;
}

async function getOrderDetailAdmin(token) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE token = $1', [token]);
  const order = rows[0];
  if (!order) return null;

  const [dispatches, funnel, charges] = await Promise.all([
    pool.query(
      'SELECT category, vehicle_size, dispatched_at FROM order_dispatches WHERE order_id = $1 ORDER BY dispatched_at',
      [order.id]
    ),
    pool.query(
      `SELECT event_type, COUNT(*)::int AS count FROM order_views WHERE order_id = $1 GROUP BY event_type`,
      [order.id]
    ),
    pool.query(
      `SELECT bt.master_id, m.name, m.phone, bt.amount_tetri, bt.created_at
       FROM balance_transactions bt
       JOIN masters m ON m.id = bt.master_id
       WHERE bt.order_id = $1 AND bt.reason = 'lead_charge'
       ORDER BY bt.created_at`,
      [order.id]
    ),
  ]);

  const funnelStats = { view: 0, call: 0, whatsapp: 0 };
  funnel.rows.forEach((row) => {
    funnelStats[row.event_type] = row.count;
  });

  return {
    ...order,
    dispatches: dispatches.rows,
    funnel: funnelStats,
    notifiedMasters: charges.rows,
  };
}

module.exports = {
  getOverviewStats,
  getResponseStats,
  listMastersAdmin,
  getMasterDetail,
  getMasterBalanceHistory,
  setMasterBanned,
  listOrdersAdmin,
  getOrderDetailAdmin,
};
