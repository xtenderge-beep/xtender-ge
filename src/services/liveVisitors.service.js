// «Сейчас на сайте» (/admin/live): кто открыт на xtender.ge прямо сейчас и на какой странице.
// Страница шлёт сигнал при открытии и раз в 30 секунд, пока вкладка на экране (public/js/visit.js); при закрытии —
// «ушёл». Запись живёт в Redis TTL_MS после последнего сигнала и потом исчезает сама: истории, кто где ходил, нет.
// Анонимная статистика посещаемости (siteAnalytics.service, site_visits) не меняется и с этим не связывается.
// Кто: узнаём только тех, кто сам вошёл в этом браузере — исполнитель (кабинет), менеджер, администратор, заказчик
// со своей заявкой в этом браузере. Остальные — «Гость». Токены из адресов не сохраняются: заявка показывается номером.
// Подробно — docs/live-visitors.md.
const crypto = require('crypto');
const pool = require('../config/db');
const redis = require('../config/redis');
const analytics = require('./siteAnalytics.service');

const TTL_MS = 90 * 1000;
const INDEX = 'live:index';
const key = tab => 'live:' + tab;
const TAB = /^[a-z0-9]{8,40}$/;

const KIND_ORDER = { provider: 0, client: 1, manager: 2, guest: 3, staff: 4 };

async function identify(req, staffFlag) {
  const cookies = req.cookies || {};
  try {
    const { SESSION_COOKIE, verifySessionValue } = require('../config/adminAuth');
    if (verifySessionValue(cookies[SESSION_COOKIE])) return { kind: 'staff', name: 'Администратор' };
  } catch (err) { /* без настроенной админки — не администратор */ }
  try {
    const portal = require('./managerPortal.service');
    const session = await portal.session(cookies[portal.COOKIE]);
    if (session?.manager) return { kind: 'manager', id: session.manager.id, name: session.manager.name };
  } catch (err) { /* нет сессии менеджера */ }
  const token = await require('./masterSession.service').token(req);
  if (token) {
    const master = (await pool.query('SELECT id, name, is_active FROM masters WHERE master_token = $1', [token])).rows[0];
    if (master) return { kind: 'provider', id: master.id, name: master.name, active: master.is_active };
  }
  // Исполнитель без входа, но с личной ссылкой на заявку из SMS, привязанной к этому браузеру (leadLink.service).
  const device = cookies.lead_device;
  if (/^[a-f0-9]{64}$/.test(device || '')) {
    const linked = (await pool.query(
      `SELECT m.id, m.name, m.is_active FROM lead_links l JOIN masters m ON m.id = l.master_id
       WHERE l.device_hash = $1 ORDER BY l.bound_at DESC LIMIT 1`, [crypto.createHash('sha256').update(device).digest('hex')])).rows[0];
    if (linked) return { kind: 'provider', id: linked.id, name: linked.name, active: linked.is_active, via: 'sms' };
  }
  let tokens = [];
  try { tokens = JSON.parse(cookies.my_orders || '[]'); } catch (err) { tokens = []; }
  if (Array.isArray(tokens) && tokens.length && typeof tokens[0] === 'string') {
    const order = (await pool.query('SELECT id FROM orders WHERE token = $1', [tokens[0].slice(0, 40)])).rows[0];
    if (order) return { kind: 'client', orderId: order.id, orders: tokens.length };
  }
  return staffFlag ? { kind: 'staff', name: 'Сотрудник (браузер помечен)' } : { kind: 'guest' };
}

// Страница: тип из анонимной статистики + понятная подробность. Токены заявок превращаются в номер заявки.
async function describe(rawPath) {
  let path = String(rawPath || '/').split(/[?#]/)[0].replace(/\/{2,}/g, '/').slice(0, 200);
  const lang = (/^\/(ru|en)(?=\/|$)/.exec(path) || [])[1] || 'ka';
  path = path.replace(/^\/(ru|en)(?=\/|$)/, '') || '/';
  if (path.length > 1) path = path.replace(/\/$/, '');
  const page = analytics.classifyPage(path);
  let detail = null;
  if (page === 'landing') detail = path;
  if (page === 'lead' || page === 'client_order') {
    const token = path.split('/')[2] || '';
    const column = page === 'lead' ? 'token' : 'owner_token';
    const order = (await pool.query(`SELECT id FROM orders WHERE ${column} = $1`, [token.slice(0, 40)])).rows[0];
    detail = order ? 'заявка #' + order.id : null;
  }
  if (page === 'other' && path.split('/').every(part => /^[a-z0-9-]{0,24}$/.test(part))) detail = path;
  return { page, label: analytics.PAGE_LABELS[page] || page, detail, pageLang: lang };
}

async function touch(req, body, { view = false } = {}) {
  const tab = String(body?.t || '');
  const userAgent = String(req.headers['user-agent'] || '');
  if (!TAB.test(tab) || analytics.isBot(userAgent)) return false;
  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  const limitKey = 'live_rate:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const hits = await redis.incr(limitKey);
  if (hits === 1) await redis.expire(limitKey, 60);
  if (hits > 240) return false;
  const now = Date.now();
  const previous = JSON.parse((await redis.get(key(tab))) || 'null');
  const where = await describe(body.p);
  const who = await identify(req, body.s === 1);
  // /master у вошедшего исполнителя — это кабинет, а не вход.
  if (where.page === 'provider_login' && who.kind === 'provider' && who.via !== 'sms') Object.assign(where, { page: 'provider_cabinet', label: analytics.PAGE_LABELS.provider_cabinet });
  const samePage = previous && previous.page === where.page && previous.detail === where.detail;
  const entry = {
    tab, who, ...where,
    device: analytics.device(userAgent, body.w), browser: analytics.browser(userAgent),
    source: view && !previous ? (analytics.parseSource(body.r, body.us, req.hostname) || 'Прямой заход') : previous?.source || 'Прямой заход',
    first: previous?.first || now, since: samePage ? previous.since : now, last: now, views: (previous?.views || 0) + (view ? 1 : 0),
  };
  await redis.set(key(tab), JSON.stringify(entry), 'PX', GONE_MS);
  await redis.zadd(INDEX, now, tab);
  return true;
}

// Ушёл со страницы: из списка сразу убираем, а сама запись ещё 10 минут помнит, когда человек пришёл и откуда, —
// переход на другую страницу сайта в той же вкладке тоже присылает «ушёл», и следующая страница продолжит визит.
const GONE_MS = 10 * 60 * 1000;
async function leave(body) {
  const tab = String(body?.t || '');
  if (!TAB.test(tab)) return;
  await redis.zrem(INDEX, tab);
  const previous = await redis.get(key(tab));
  if (previous) await redis.set(key(tab), JSON.stringify({ ...JSON.parse(previous), left: Date.now() }), 'PX', GONE_MS);
}

async function list() {
  const now = Date.now();
  await redis.zremrangebyscore(INDEX, 0, now - TTL_MS);
  const tabs = await redis.zrangebyscore(INDEX, now - TTL_MS, '+inf');
  const values = tabs.length ? await redis.mget(tabs.map(key)) : [];
  const people = values.filter(Boolean).map(v => JSON.parse(v)).filter(p => !(p.left && p.left >= p.last) && now - p.last <= TTL_MS)
    .sort((a, b) => (KIND_ORDER[a.who.kind] - KIND_ORDER[b.who.kind]) || (b.last - a.last));
  // Ссылка админки на заявку идёт по её адресу; в Redis адреса нет — берём из базы при показе.
  const orderIds = [...new Set(people.filter(p => p.who.kind === 'client').map(p => p.who.orderId))];
  if (orderIds.length) {
    const rows = (await pool.query(`SELECT id, token FROM orders WHERE id IN (${orderIds.map((_, i) => '$' + (i + 1)).join(', ')})`, orderIds)).rows;
    const tokenOf = Object.fromEntries(rows.map(r => [r.id, r.token]));
    for (const p of people) if (p.who.kind === 'client') p.who.orderLink = tokenOf[p.who.orderId] ? '/admin/orders/' + tokenOf[p.who.orderId] : null;
  }
  const counts = { total: 0, provider: 0, client: 0, manager: 0, guest: 0, staff: 0 };
  for (const p of people) { counts[p.who.kind]++; if (p.who.kind !== 'staff') counts.total++; }
  return { now, people, counts };
}

module.exports = { touch, leave, list, identify, describe, TTL_MS };
