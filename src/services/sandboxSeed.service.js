// Тестовые исполнители в тестовом окружении (Railway staging): только при XTENDER_SANDBOX=1 и SANDBOX_SEED=1, иначе ничего
// не делает. Повторный запуск не создаёт дублей (по номеру). На рабочем сайте XTENDER_SANDBOX не задан — функция выходит сразу.
const crypto = require('node:crypto');
const pool = require('../config/db');
const { SANDBOX } = require('../config/sandboxData');

async function run() {
  if (!require('../config/apiV1').isSandbox() || process.env.SANDBOX_SEED !== '1') return 0;
  const city = (await pool.query("SELECT id FROM cities WHERE slug='tbilisi'")).rows[0]?.id;
  if (!city) return 0;
  let created = 0;
  for (const p of SANDBOX.providers) {
    if ((await pool.query('SELECT id FROM masters WHERE phone=$1', [p.phone])).rows[0]) continue;
    await pool.withTransaction(async (client) => {
      const master = (await client.query(
        `INSERT INTO masters (name, phone, category, description, is_active, is_subscribed, balance_tetri, master_token, city_id, spoken_languages, is_technical)
         VALUES ($1,$2,$3,$4,$5,true,0,$6,$7,$8::jsonb,false) RETURNING id`,
        [p.name, p.phone, p.service === 'van' ? 'transport' : p.service, p.description, p.active, crypto.randomBytes(10).toString('hex'), city, JSON.stringify(p.languages)])).rows[0];
      await client.query('INSERT INTO master_services (master_id, service_type, attributes, is_primary) VALUES ($1,$2,$3::jsonb,true)', [master.id, p.service, JSON.stringify(p.attributes)]);
      await client.query('INSERT INTO master_cities (master_id, city_id) VALUES ($1,$2)', [master.id, city]);
    });
    created += 1;
  }
  if (created) console.log(`[sandbox] seeded ${created} test providers`);
  return created;
}

module.exports = { run };
