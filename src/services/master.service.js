const pool = require('../config/db');
const { generateShortId } = require('../config/shortId');

const FIELDS = 'id, name, phone, category, vehicle_type, vehicle_size, price_text, description, avatar_url, rating';

async function registerMaster({ name, phone, category, vehicleType, vehicleSize, priceText, description }) {
  const masterToken = generateShortId();
  const { rows } = await pool.query(
    `INSERT INTO masters (name, phone, category, vehicle_type, vehicle_size, price_text, description, is_active, balance_tetri, master_token, terms_accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 0, $8, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       vehicle_type = EXCLUDED.vehicle_type,
       vehicle_size = EXCLUDED.vehicle_size,
       price_text = EXCLUDED.price_text,
       description = EXCLUDED.description,
       is_active = false,
       master_token = COALESCE(masters.master_token, EXCLUDED.master_token),
       terms_accepted_at = NOW()
     RETURNING *`,
    [name, phone, category, vehicleType || null, vehicleSize || null, priceText || null, description || null, masterToken]
  );
  return rows[0];
}

async function getMasterByToken(token) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason FROM masters WHERE master_token = $1`,
    [token]
  );
  return rows[0] || null;
}

async function approveMaster(id) {
  const { rows } = await pool.query(
    `UPDATE masters SET is_active = true WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function getMasterByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason FROM masters WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

// Единственная точка изменения баланса — каждое изменение пишет строку в
// balance_transactions в той же транзакции, чтобы история никогда не разошлась
// с реальным balance_tetri. Передавайте client из pool.withTransaction(...),
// когда вызов идёт не изолированно (см. chargeMastersForLead, topUpBalance).
async function adjustBalance({ masterId, phone, amountTetri, reason, orderId = null, note = null }, client = pool) {
  if (!masterId && !phone) throw new Error('adjustBalance requires masterId or phone');
  const idColumn = masterId ? 'id' : 'phone'; // литерал, не пользовательский ввод
  const { rows } = await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE ${idColumn} = $2 RETURNING *`,
    [amountTetri, masterId || phone]
  );
  const master = rows[0];
  if (!master) return null;
  await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id, note) VALUES ($1, $2, $3, $4, $5)`,
    [master.id, amountTetri, reason, orderId, note]
  );
  return master;
}

// Списание за лид сразу по всем уведомлённым мастерам одним UPDATE + один multi-row
// INSERT в журнал (заодно фиксирует, кому реально ушло уведомление по заявке — эта
// связь раньше нигде не хранилась). Плейсхолдеры строятся вручную, как в
// getOrdersByTokens/attachFiles в order.service.js — не через ANY($::int[])/UNNEST:
// оба варианта не работают под pg-mem (используется для локальной разработки,
// dev-server.js), а IN (...) с явными плейсхолдерами работает одинаково и там, и на
// реальном Postgres.
async function chargeMastersForLead(masterIds, amountTetri, orderId, client = pool) {
  if (!masterIds.length) return;

  const idPlaceholders = masterIds.map((_, i) => `$${i + 2}`).join(', ');
  await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE id IN (${idPlaceholders})`,
    [-amountTetri, ...masterIds]
  );

  const values = [];
  const rowPlaceholders = masterIds
    .map((masterId, i) => {
      const base = i * 3;
      values.push(masterId, -amountTetri, orderId);
      return `($${base + 1}, $${base + 2}, 'lead_charge', $${base + 3})`;
    })
    .join(', ');
  await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id) VALUES ${rowPlaceholders}`,
    values
  );
}

async function topUpBalance(phone, amountTetri) {
  return pool.withTransaction((client) => adjustBalance({ phone, amountTetri, reason: 'topup' }, client));
}

// Редактирование профиля из админки — единственное место, где допускается менять
// category/vehicle_size вручную (при саморегистрации на /join vehicle_size сознательно
// остаётся NULL — «любой размер», см. HANDOFF.md; тут модератор может сузить конкретного
// мастера до одного тира).
async function updateMasterProfile(id, { name, phone, category, vehicleType, vehicleSize, isFlatbed, priceText, description }) {
  const { rows } = await pool.query(
    `UPDATE masters SET name = $1, phone = $2, category = $3, vehicle_type = $4, vehicle_size = $5,
            is_flatbed = $6, price_text = $7, description = $8
     WHERE id = $9 RETURNING *`,
    [name, phone, category, vehicleType || null, vehicleSize || null, isFlatbed, priceText || null, description || null, id]
  );
  return rows[0] || null;
}

const LIST_FIELDS = 'm.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url';

async function listMasters({ category } = {}) {
  const params = [];
  let where = 'm.is_active = true AND m.is_banned = false';
  if (category) {
    params.push(category);
    where += ` AND m.category = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${LIST_FIELDS}, COALESCE(AVG(r.rating)::numeric(3,2), 0) AS rating, COUNT(r.id)::int AS review_count
     FROM masters m
     LEFT JOIN master_reviews r ON r.master_id = m.id AND r.is_approved = true
     WHERE ${where}
     GROUP BY m.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url
     ORDER BY m.id`,
    params
  );
  return rows;
}

module.exports = {
  registerMaster,
  getMasterByToken,
  getMasterByPhone,
  approveMaster,
  updateMasterProfile,
  adjustBalance,
  chargeMastersForLead,
  topUpBalance,
  listMasters,
};
