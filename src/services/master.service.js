const pool = require('../config/db');

const FIELDS = 'id, name, phone, category, vehicle_type, vehicle_size, price_text, description, avatar_url, rating';

async function seedTestMaster() {
  const { rows } = await pool.query(
    `INSERT INTO masters (name, phone, category, vehicle_type, vehicle_size, price_text, description, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       vehicle_type = EXCLUDED.vehicle_type,
       vehicle_size = EXCLUDED.vehicle_size,
       price_text = EXCLUDED.price_text,
       description = EXCLUDED.description,
       is_active = true
     RETURNING id, name, phone, category`,
    [
      'Тест Мастер',
      '+995599994854',
      'transport',
      'Ford Transit (высокий кузов)',
      'L',
      'от 60 GEL / рейс',
      'Тестовый мастер для проверки SMS-рассылки',
    ]
  );
  return rows[0];
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
  seedTestMaster,
  listMasters,
};
