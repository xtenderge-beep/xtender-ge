// Песочница API v1 на своём компьютере: node scripts/api-sandbox.js → http://127.0.0.1:3100
// База и Redis в памяти (pg-mem, ioredis-mock), настоящих SMS и Telegram нет: SMS складываются в список
// GET /api/v1/sandbox/sms. Тестовые данные: заказчик и два исполнителя (плюс один на модерации). Все номера
// выдуманные, помечены в именах «SANDBOX». Как получить токен — scripts/api-sandbox-token.js и docs/api-v1/README.md.
// Продовый .env здесь не читается: dotenv в app.js не перезаписывает переменные, заданные ниже, а ключей шлюза и
// бота мы не задаём; XTENDER_SANDBOX=1 вдобавок запрещает отправку в sms.service и telegram.service.
process.env.NODE_ENV = 'development';
process.env.XTENDER_SANDBOX = '1';
process.env.PORT = process.env.PORT || '3100';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:' + process.env.PORT;
process.env.DOMAIN = '127.0.0.1:' + process.env.PORT;
process.env.SKIP_DB_MIGRATIONS = '1';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
for (const name of ['SMS_GATEWAY_USERNAME', 'SMS_GATEWAY_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_MODERATOR_CHAT_ID', 'OPENROUTER_API_KEY', 'SANDBOX_REAL_SMS_NUMBERS', 'SANDBOX_SINK_KEY']) process.env[name] = '';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'ioredis') request = 'ioredis-mock';
  return originalResolve.call(this, request, ...args);
};
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async (fn) => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: function () { return pool; } };
  return originalLoad.call(this, request, parent, isMain);
};

const { SANDBOX } = require('../src/config/sandboxData');

async function seed() {
  const city = (await pool.query("SELECT id FROM cities WHERE slug='tbilisi'")).rows[0].id;
  for (const [index, p] of SANDBOX.providers.entries()) {
    const master = (await pool.query(
      `INSERT INTO masters (name, phone, category, description, is_active, is_subscribed, balance_tetri, master_token, city_id, spoken_languages, is_technical)
       VALUES ($1,$2,$3,$4,$5,true,0,$6,$7,$8::jsonb,false) RETURNING id`,
      [p.name, p.phone, p.service === 'van' ? 'transport' : p.service, p.description, p.active, 'sandbox-master-' + (index + 1), city, JSON.stringify(p.languages)])).rows[0];
    await pool.query('INSERT INTO master_services (master_id, service_type, attributes, is_primary) VALUES ($1,$2,$3::jsonb,true)', [master.id, p.service, JSON.stringify(p.attributes)]);
    await pool.query('INSERT INTO master_cities (master_id, city_id) VALUES ($1,$2)', [master.id, city]);
  }
}

seed().then(() => {
  require(path.join(root, 'src', 'app.js'));
  const base = process.env.PUBLIC_BASE_URL;
  console.log('\nAPI SANDBOX: in-memory database, no real SMS or Telegram.');
  console.log(`  Capabilities: ${base}/api/v1/capabilities`);
  console.log(`  OpenAPI:      ${base}/api/v1/openapi.json`);
  console.log(`  SMS sink:     ${base}/api/v1/sandbox/sms`);
  console.log(`  Customer phone: ${SANDBOX.customer}; providers: ${SANDBOX.providers.map((p) => p.phone + (p.active ? '' : ' (pending)')).join(', ')}`);
  console.log(`  Token:        node scripts/api-sandbox-token.js ${SANDBOX.customer}\n`);
});

module.exports = { SANDBOX };
