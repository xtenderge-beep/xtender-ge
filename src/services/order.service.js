const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const smsService = require('./sms.service');

async function createOrder({ phone, description, districtName, targetCategories }) {
  const token = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO orders (phone, description, district_name, token, target_categories, status)
     VALUES ($1, $2, $3, $4, $5, 'new') RETURNING *`,
    [phone, description, districtName, token, targetCategories]
  );
  return rows[0];
}

async function getOrderByToken(token) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE token = $1', [token]);
  return rows[0] || null;
}

async function closeOrder(token) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'closed' WHERE token = $1 AND status != 'closed' RETURNING *`,
    [token]
  );
  return rows[0] || null;
}

async function notifyMasters(order, categories) {
  const { rows: masters } = await pool.query(
    'SELECT id, phone FROM masters WHERE is_active = true AND category = ANY($1::text[])',
    [categories && categories.length ? categories : []]
  );
  const base = process.env.DOMAIN ? `http://${process.env.DOMAIN}` : 'http://localhost:3000';

  await Promise.all(
    masters.map((master) => {
      const link = `${base}/order/${order.token}?master=${master.id}`;
      const text = `Xtender: новый заказ (${order.district_name}): ${order.description.slice(0, 100)} ${link}`;
      return smsService.sendOrderNotification(master.phone, text).catch((err) => {
        console.error(`Failed to notify master ${master.id}:`, err.message);
      });
    })
  );
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

async function logView(orderId, masterId) {
  await pool.query(
    `INSERT INTO order_views (order_id, master_id) VALUES ($1, $2)
     ON CONFLICT (order_id, master_id) DO NOTHING`,
    [orderId, masterId]
  );
}

module.exports = {
  createOrder,
  getOrderByToken,
  closeOrder,
  notifyMasters,
  logView,
  attachFiles,
  getOrderFiles,
};
