const pool = require('../config/db');

const FIELDS = 'id, name, phone, category, vehicle_type, vehicle_size, price_text, description, avatar_url, rating';

async function registerMaster({ name, phone, category, vehicleType, vehicleSize, priceText, description }) {
  const { rows } = await pool.query(
    `INSERT INTO masters (name, phone, category, vehicle_type, vehicle_size, price_text, description, is_active, balance_tetri)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 0)
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       vehicle_type = EXCLUDED.vehicle_type,
       vehicle_size = EXCLUDED.vehicle_size,
       price_text = EXCLUDED.price_text,
       description = EXCLUDED.description,
       is_active = false
     RETURNING *`,
    [name, phone, category, vehicleType || null, vehicleSize || null, priceText || null, description || null]
  );
  return rows[0];
}

async function approveMaster(id) {
  const { rows } = await pool.query(
    `UPDATE masters SET is_active = true WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function topUpBalance(phone, amountTetri) {
  const { rows } = await pool.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE phone = $2 RETURNING *`,
    [amountTetri, phone]
  );
  return rows[0] || null;
}

async function listMasters({ category } = {}) {
  if (category) {
    const { rows } = await pool.query(
      `SELECT ${FIELDS} FROM masters WHERE is_active = true AND category = $1 ORDER BY id`,
      [category]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT ${FIELDS} FROM masters WHERE is_active = true ORDER BY id`
  );
  return rows;
}

module.exports = {
  registerMaster,
  approveMaster,
  topUpBalance,
  listMasters,
};
