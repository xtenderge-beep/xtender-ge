// Общий стенд тестов API v1 (tests/api-v1-*.test.js): pg-mem со схемой schema.sql, Redis в памяти, настоящие
// сервисы и маршруты OAuth и /api/v1. SMS не уходят никуда: XTENDER_SANDBOX=1 складывает их в приёмник песочницы,
// оттуда стенд берёт код — тот же путь, что у человека на странице входа. Telegram заглушён.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { newDb } = require('pg-mem');

process.env.XTENDER_SANDBOX = '1';
process.env.NODE_ENV = 'test';
delete process.env.DOMAIN;

// API_TEST_DATABASE_URL — прогнать те же тесты на настоящем Postgres (пустая база): схема накатывается как при
// старте сайта (src/app.js runMigrations), транзакции настоящие. Без переменной — pg-mem, как остальные тесты.
const realPg = process.env.API_TEST_DATABASE_URL;
let db = null;
let pool;
if (realPg) {
  process.env.DATABASE_URL = realPg;
  pool = require('../src/config/db');
} else {
  db = newDb();
  db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
  const { Pool } = db.adapters.createPg();
  pool = new Pool();
  pool.withTransaction = async (fn) => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
}
const redis = new (require('ioredis-mock'))();
const stub = (name, exports) => (require.cache[require.resolve(name)] = { exports });
if (!realPg) stub('../src/config/db', pool);
stub('../src/config/redis', redis);
stub('../src/services/telegram.service', new Proxy({}, { get: () => async () => null }));

const express = require('express');
const { normalizeLang, translate } = require('../src/config/i18n');
const { obtainToken } = require('../scripts/api-sandbox-token');

// Журнал сервера на время тестов: проверяем, что в него не попадают токены и номера телефонов.
const logged = [];
for (const method of ['log', 'error', 'warn']) {
  const original = console[method].bind(console);
  console[method] = (...args) => { logged.push(args.map(String).join(' ')); if (method !== 'log' || process.env.API_TEST_VERBOSE) original(...args); };
}

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../src/views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(require('cookie-parser')());
  app.use((req, res, next) => {
    req.lang = normalizeLang(req.cookies.lang);
    Object.assign(res.locals, { lang: req.lang, t: translate(req.lang), currentPath: req.originalUrl });
    next();
  });
  app.use(require('../src/routes/oauth.routes'));
  app.use('/api/v1', require('../src/routes/apiV1.routes'));
  // Как в src/app.js: неверный JSON к /api/v1 отклоняет общий разборщик тела.
  app.use((err, req, res, next) => {
    if (req.path.startsWith('/api/v1/')) return require('../src/middleware/apiV1').errorHandler(err, req, res, next);
    console.error(err);
    res.status(500).send('error');
  });
  return app;
}

async function start() {
  if (realPg) {
    await pool.query('DROP VIEW IF EXISTS business_orders, business_masters CASCADE');
    await pool.query(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '../schema.postgres.sql'), 'utf8'));
  }
  const server = await new Promise((resolve) => { const s = http.createServer(buildApp()).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
  if (realPg) {
    const close = server.close.bind(server);
    server.close = (...args) => { pool.end().catch(() => {}); return close(...args); };
  }
  return { server, base };
}

// Лимиты кодов и входов рассчитаны на людей; тесты входят много раз подряд с одного адреса.
async function resetLimits(phone) {
  const keys = [...await redis.keys('oauth_limit:*'), ...await redis.keys('otp_limit:oauth:*'), ...await redis.keys('otp_attempts:oauth:*')];
  if (keys.length) await redis.del(...keys);
  if (phone) await redis.del('otp:oauth:' + phone);
}

async function login(base, phone, scope = 'profile:read profile:write') {
  await resetLimits(phone);
  return obtainToken({ base, phone, scope });
}

let phones = 0;
async function addMaster({ phone, service = 'movers', attributes = {}, active = true, banned = false, languages = ['ka'], name } = {}) {
  phones += 1;
  const number = phone || '+9955990' + String(10000 + phones);
  const city = (await pool.query("SELECT id FROM cities WHERE slug='tbilisi'")).rows[0].id;
  const master = (await pool.query(
    `INSERT INTO masters (name, phone, category, is_active, is_banned, is_subscribed, balance_tetri, master_token, city_id, spoken_languages)
     VALUES ($1,$2,$3,$4,$5,true,0,$6,$7,$8::jsonb) RETURNING *`,
    [name || 'Provider ' + phones, number, service === 'van' ? 'transport' : service, active, banned, 'tok-' + phones, city, JSON.stringify(languages)])).rows[0];
  await pool.query('INSERT INTO master_services (master_id, service_type, attributes, is_primary) VALUES ($1,$2,$3::jsonb,true)', [master.id, service, JSON.stringify(attributes)]);
  await pool.query('INSERT INTO master_cities (master_id, city_id) VALUES ($1,$2)', [master.id, city]);
  require('../src/services/apiCatalog.service').resetSupply();
  return master;
}

function client(base) {
  return async function call(method, url, { token, body, headers = {} } = {}) {
    const response = await fetch(base + url, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, headers: response.headers, json, text };
  };
}

module.exports = { db, pool, redis, start, login, resetLimits, addMaster, client, logged };
