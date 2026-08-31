const pool = require('../config/db');
const smsService = require('./sms.service');
const masterService = require('./master.service');
const { getBaseUrl } = require('../config/url');
const { generateShortId } = require('../config/shortId');

const COST_PER_NOTIFICATION_TETRI = 30;

async function createPendingOrder({ phone, description, districtName }) {
  const token = generateShortId();
  const ownerToken = generateShortId();
  const { rows } = await pool.query(
    `INSERT INTO orders (phone, description, district_name, token, owner_token, target_categories, status)
     VALUES ($1, $2, $3, $4, $5, '{}', 'unverified') RETURNING *`,
    [phone, description, districtName, token, ownerToken]
  );
  return rows[0];
}

async function getOrderByOwnerToken(ownerToken) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE owner_token = $1', [ownerToken]);
  return rows[0] || null;
}

async function activateOrder(token, phone) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'pending_review'
     WHERE token = $1 AND phone = $2 AND status = 'unverified' RETURNING *`,
    [token, phone]
  );
  return rows[0] || null;
}

async function setModerationMessageId(orderId, messageId) {
  await pool.query('UPDATE orders SET moderation_message_id = $1 WHERE id = $2', [messageId, orderId]);
}

async function getOrderByToken(token) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE token = $1', [token]);
  return rows[0] || null;
}

async function getOrdersByTokens(tokens) {
  if (!tokens || !tokens.length) return [];
  const placeholders = tokens.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE token IN (${placeholders}) ORDER BY created_at DESC`,
    tokens
  );
  return rows;
}

async function recordDispatch(orderId, category, vehicleSize) {
  try {
    await pool.query(
      `INSERT INTO order_dispatches (order_id, category, vehicle_size) VALUES ($1, $2, $3)`,
      [orderId, category, vehicleSize || '']
    );
    return true;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function getOrderDispatches(orderId) {
  const { rows: dispatches } = await pool.query(
    `SELECT category, vehicle_size FROM order_dispatches WHERE order_id = $1 ORDER BY dispatched_at`,
    [orderId]
  );
  if (!dispatches.length) return [];

  const counts = await getMasterCountsByCategory();
  const totalFor = (category) =>
    counts.filter((row) => row.category === category).reduce((sum, row) => sum + row.count, 0);
  const sizedFor = (category, size) => {
    const row = counts.find((row) => row.category === category && row.vehicle_size === size);
    return row ? row.count : 0;
  };

  return dispatches.map((d) => ({
    category: d.category,
    vehicle_size: d.vehicle_size,
    master_count: d.vehicle_size ? sizedFor(d.category, d.vehicle_size) : totalFor(d.category),
  }));
}

async function addTargetCategories(token, categories) {
  const existing = await getOrderByToken(token);
  if (!existing || existing.status === 'closed') return null;

  const merged = [...new Set([...(existing.target_categories || []), ...categories])];
  const { rows } = await pool.query(
    `UPDATE orders SET target_categories = $1,
         status = CASE WHEN status = 'pending_review' THEN 'new' ELSE status END
     WHERE token = $2 RETURNING *`,
    [merged, token]
  );
  return rows[0] || null;
}

async function markFirstDispatch(token) {
  const { rows } = await pool.query(
    `UPDATE orders SET first_dispatched_at = NOW()
     WHERE token = $1 AND first_dispatched_at IS NULL RETURNING *`,
    [token]
  );
  return Boolean(rows[0]);
}

async function closeOrder(token) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'closed', closed_at = NOW()
     WHERE token = $1 AND status != 'closed' RETURNING *`,
    [token]
  );
  return rows[0] || null;
}

async function getMasterCountsByCategory() {
  const { rows } = await pool.query(
    `SELECT category, vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
     GROUP BY category, vehicle_size
     UNION ALL
     SELECT 'flatbed' AS category, NULL AS vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
       AND category = 'transport' AND is_flatbed = true`,
    [COST_PER_NOTIFICATION_TETRI]
  );
  return rows;
}

const EVENT_TYPES = ['view', 'call', 'whatsapp'];

async function getOrderFunnelStats(orderId) {
  const { rows } = await pool.query(
    `SELECT event_type, COUNT(*)::int AS count FROM order_views
     WHERE order_id = $1 GROUP BY event_type`,
    [orderId]
  );
  const stats = { view: 0, call: 0, whatsapp: 0 };
  rows.forEach((row) => {
    stats[row.event_type] = row.count;
  });
  return stats;
}

async function notifyMasters(order, category, vehicleSize) {
  const params = [COST_PER_NOTIFICATION_TETRI];
  let query = `SELECT id, phone FROM masters
               WHERE is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
                 AND (subscription_until IS NULL OR subscription_until > NOW())`;

  if (category === 'flatbed') {
    query += ` AND category = 'transport' AND is_flatbed = true`;
  } else {
    params.push(category);
    query += ` AND category = $${params.length}`;
    if (vehicleSize) {
      params.push(vehicleSize);
      query += ` AND (vehicle_size = $${params.length} OR vehicle_size IS NULL)`;
    }
  }

  const { rows: masters } = await pool.query(query, params);
  const base = getBaseUrl();

  const notifiedIds = [];
  await Promise.all(
    masters.map(async (master) => {
      const link = `${base}/order/${order.token}?master=${master.id}`;
      const text = `Xtender: new order #${order.id}: ${link}`;
      try {
        await smsService.sendOrderNotification(master.phone, text);
        notifiedIds.push(master.id);
      } catch (err) {
        console.error(`Failed to notify master ${master.id}:`, err.message);
      }
    })
  );

  if (notifiedIds.length) {
    await pool.withTransaction((client) =>
      masterService.chargeMastersForLead(notifiedIds, COST_PER_NOTIFICATION_TETRI, order.id, client)
    );
  }

  return masters.length;
}

async function attachFiles(orderId, files) {
  if (!files || !files.length) return;

  const values = [];
  const placeholders = files
    .map((file, i) => {
      const base = i * 4;
      values.push(orderId, `/uploads/${file.filename}`, file.originalname, file.mimetype);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    })
    .join(', ');

  await pool.query(
    `INSERT INTO order_files (order_id, file_path, original_name, mime_type) VALUES ${placeholders}`,
    values
  );
}

async function getOrderFiles(orderId) {
  const { rows } = await pool.query(
    'SELECT id, file_path, original_name, mime_type FROM order_files WHERE order_id = $1 ORDER BY id',
    [orderId]
  );
  return rows;
}

async function logView(orderId, masterId, eventType) {
  const type = EVENT_TYPES.includes(eventType) ? eventType : 'view';
  await pool.query(
    `INSERT INTO order_views (order_id, master_id, event_type) VALUES ($1, $2, $3)
     ON CONFLICT (order_id, master_id, event_type) DO NOTHING`,
    [orderId, masterId, type]
  );
}

module.exports = {
  createPendingOrder,
  activateOrder,
  getOrderByToken,
  getOrderByOwnerToken,
  getOrdersByTokens,
  addTargetCategories,
  recordDispatch,
  getOrderDispatches,
  markFirstDispatch,
  setModerationMessageId,
  closeOrder,
  notifyMasters,
  getMasterCountsByCategory,
  getOrderFunnelStats,
  logView,
  attachFiles,
  getOrderFiles,
};
