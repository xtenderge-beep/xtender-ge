const pool = require('../config/db');

const FIELDS = 'id, name, phone, category, vehicle_type, price_text, description, avatar_url, rating';

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
  listMasters,
};
