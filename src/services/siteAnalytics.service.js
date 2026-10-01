const crypto = require('crypto');
const pool = require('../config/db');
const redis = require('../config/redis');

// Собственная аналитика посещаемости вместо Google Analytics (вкладка «Посещаемость» в /admin).
// Сбор — public/js/visit.js шлёт POST /api/v на каждый просмотр публичной страницы.
// Приватность (политика обещает только необходимые куки): куки не ставим, IP не храним.
// Посетитель — sha256(соль дня + IP + браузер), соль живёт сутки только в Redis, поэтому
// один человек в разные дни — разные посетители, и связать запись с человеком нельзя.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const VISIT_GAP_MS = 30 * 60 * 1000; // новый визит после 30 минут тишины
const ONLINE_MS = 5 * 60 * 1000;
const KEEP_DAYS = 400;
const tbilisiDate = ms => new Date(ms + 4 * HOUR).toISOString().slice(0, 10);

// Тип страницы вместо адреса: токены из адресов никогда не попадают в базу.
const PAGES = [
  [/^\/$/, 'home'], [/^\/join$/, 'join'], [/^\/guides\/request$/, 'guide'],
  [/^\/terms$/, 'terms'], [/^\/privacy$/, 'privacy'], [/^\/my-orders$/, 'my_orders'],
  [/^\/order\/[^/]+$/, 'lead'], [/^\/o\/[^/]+$/, 'client_order'], [/^\/review\/[^/]+$/, 'review'],
  [/^\/master$/, 'provider_login'], [/^\/master\/[^/]+\/topups(\/|$)/, 'provider_topup'],
  [/^\/master\/[^/]+$/, 'provider_cabinet'], [/^\/[id]\/[^/]+$/, 'manager_link'],
];
const PAGE_LABELS = {
  home: 'Главная', join: 'Регистрация исполнителя', guide: 'Гайд «Как оставить заявку»', terms: 'Оферта',
  privacy: 'Политика конфиденциальности', my_orders: 'Мои заявки', lead: 'Заявка (открыл исполнитель)',
  client_order: 'Страница заявки заказчика', review: 'Отзыв', provider_login: 'Вход исполнителя',
  provider_topup: 'Пополнение баланса', provider_cabinet: 'Кабинет исполнителя', manager_link: 'Ссылка менеджера', other: 'Другое',
};

function classifyPage(rawPath) {
  let path = String(rawPath || '/').split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  path = path.replace(/^\/(ru|en)(?=\/|$)/, '') || '/';
  if (path.length > 1) path = path.replace(/\/$/, '');
  for (const [re, page] of PAGES) if (re.test(path)) return page;
  return 'other';
}

const KNOWN_SOURCES = [
  [/(^|\.)google\./, 'Google'], [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'], [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(t\.me|telegram\.org|telegram\.me)$/, 'Telegram'], [/(^|\.)(wa\.me|whatsapp\.com)$/, 'WhatsApp'],
  [/(^|\.)yandex\./, 'Yandex'], [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)viber\.com$/, 'Viber'], [/(^|\.)linkedin\.com$/, 'LinkedIn'], [/(^|\.)(myhome|ss)\.ge$/, null],
];

// Внешний источник входа: utm_source важнее реферера; переходы внутри сайта — не источник.
function parseSource(referrer, utmSource, ownHost) {
  const utm = String(utmSource || '').trim().toLowerCase().slice(0, 80);
  if (utm) return utm;
  let host;
  try { host = new URL(String(referrer || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  if (!host) return null;
  const own = String(ownHost || '').toLowerCase().replace(/^www\./, '').split(':')[0];
  if (own && (host === own || host.endsWith('.' + own))) return null;
  for (const [re, label] of KNOWN_SOURCES) if (re.test(host)) return label || host;
  return host.slice(0, 80);
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python|java\/|phantom|puppeteer|playwright|facebookexternalhit|whatsapp|telegram/i;
function isBot(userAgent) { return !userAgent || BOT.test(userAgent); }

function device(userAgent, width) {
  const ua = String(userAgent || '');
  if (/ipad|tablet|kindle|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  const w = Number(width);
  if (Number.isFinite(w) && w > 0 && w < 768) return 'mobile';
  return 'desktop';
}

function browser(userAgent) {
  const ua = String(userAgent || '');
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser/i.test(ua)) return 'Samsung';
  if (/yabrowser/i.test(ua)) return 'Yandex';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Другой';
}

async function daySalt(now = Date.now()) {
  const key = 'analytics_salt:' + tbilisiDate(now);
  await redis.set(key, crypto.randomBytes(16).toString('hex'), 'EX', 2 * 24 * 3600, 'NX');
  return redis.get(key);
}

const clip = (value, n) => { const s = String(value || '').trim(); return s ? s.slice(0, n) : null; };

// Один просмотр страницы. Возвращает false, если не записали (бот, лимит, мусор).
async function record({ path, referrer, utmSource, utmMedium, utmCampaign, lang, width, staff, ip, userAgent, host, country }) {
  if (isBot(userAgent) || !ip) return false;
  const limitKey = 'analytics_rate:' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
  const hits = await redis.incr(limitKey);
  if (hits === 1) await redis.expire(limitKey, 60);
  if (hits > 120) return false;
  const salt = await daySalt();
  const visitor = crypto.createHash('sha256').update(salt + '|' + ip + '|' + userAgent).digest('hex').slice(0, 16);
  const code = /^[A-Z]{2}$/.test(String(country || '')) && country !== 'XX' && country !== 'T1' ? country : null;
  await pool.query(`INSERT INTO site_visits(visitor,page,source,utm_medium,utm_campaign,device,browser,country,lang,is_staff)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [visitor, classifyPage(path), parseSource(referrer, utmSource, host), clip(utmMedium, 80), clip(utmCampaign, 120),
      device(userAgent, width), browser(userAgent), code, ['ka', 'ru', 'en'].includes(lang) ? lang : null, Boolean(staff)]);
  return true;
}

// Визиты: просмотры одного посетителя без паузы больше 30 минут.
function summarize(rows) {
  const last = new Map();
  const visits = [];
  for (const row of rows) {
    const at = new Date(row.created_at).getTime();
    const prev = last.get(row.visitor);
    if (!prev || at - prev.at > VISIT_GAP_MS) {
      const visit = { visitor: row.visitor, source: row.source || 'Прямой заход', page: row.page, device: row.device,
        browser: row.browser, country: row.country || '—', lang: row.lang || '—', views: 0, at };
      visits.push(visit);
      last.set(row.visitor, { at, visit });
    } else last.set(row.visitor, { at, visit: prev.visit });
    last.get(row.visitor).visit.views++;
  }
  const visitorDays = new Set(rows.map(r => r.visitor + '|' + tbilisiDate(new Date(r.created_at).getTime())));
  return { pageviews: rows.length, visitors: visitorDays.size, visits: visits.length,
    bounces: visits.filter(v => v.views === 1).length, visitList: visits };
}

function top(items, key, limit = 10) {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}

async function rowsBetween(start, end) {
  return (await pool.query(`SELECT visitor, page, source, device, browser, country, lang, created_at FROM site_visits
    WHERE created_at >= $1 AND created_at < $2 AND is_staff = false ORDER BY created_at, id`, [new Date(start), new Date(end)])).rows;
}

async function report(window, now = Date.now()) {
  const [rows, previousRows, online, registrations] = await Promise.all([
    rowsBetween(window.start, window.end),
    rowsBetween(window.previousStart, window.previousEnd),
    pool.query('SELECT COUNT(DISTINCT visitor)::int AS n FROM site_visits WHERE created_at >= $1 AND is_staff = false', [new Date(now - ONLINE_MS)]),
    pool.query('SELECT COUNT(*)::int AS n FROM masters WHERE created_at >= $1 AND created_at < $2 AND is_technical = false', [new Date(window.start), new Date(window.end)]),
  ]);
  const current = summarize(rows), previous = summarize(previousRows);
  // График: по часам для «Сегодня», иначе по дням (Тбилиси).
  const hourly = window.end - window.start <= DAY;
  const bucketOf = ms => hourly ? new Date(ms + 4 * HOUR).toISOString().slice(11, 13) + ':00' : tbilisiDate(ms).slice(5).split('-').reverse().join('.');
  const buckets = [];
  for (let t = window.start; t < window.end; t += hourly ? HOUR : DAY) buckets.push({ label: bucketOf(t), views: 0, visitors: new Set() });
  const byLabel = new Map(buckets.map(b => [b.label, b]));
  for (const row of rows) {
    const b = byLabel.get(bucketOf(new Date(row.created_at).getTime()));
    if (b) { b.views++; b.visitors.add(row.visitor); }
  }
  const pageVisitors = page => new Set(rows.filter(r => r.page === page).map(r => r.visitor + '|' + tbilisiDate(new Date(r.created_at).getTime()))).size;
  const pages = top(rows, 'page', 20).map(p => ({ ...p, label: PAGE_LABELS[p.name] || p.name, visitors: pageVisitors(p.name) }));
  const visits = current.visitList;
  return {
    hasData: rows.length > 0, since: (await pool.query('SELECT MIN(created_at) AS at FROM site_visits')).rows[0].at,
    current: { visitors: current.visitors, visits: current.visits, pageviews: current.pageviews,
      bounceRate: current.visits ? Math.round(current.bounces * 1000 / current.visits) / 10 : null,
      viewsPerVisit: current.visits ? Math.round(current.pageviews * 10 / current.visits) / 10 : null },
    previous: { visitors: previous.visitors, visits: previous.visits, pageviews: previous.pageviews },
    online: online.rows[0].n,
    chart: buckets.map(b => ({ label: b.label, views: b.views, visitors: b.visitors.size })), hourly,
    pages, sources: top(visits, 'source'), entries: top(visits, 'page').map(p => ({ ...p, label: PAGE_LABELS[p.name] || p.name })),
    devices: top(visits, 'device'), browsers: top(visits, 'browser'), countries: top(visits, 'country'), langs: top(visits, 'lang'),
    homeVisitors: pageVisitors('home'), joinVisitors: pageVisitors('join'), registrations: registrations.rows[0].n,
  };
}

function start() {
  const cleanup = () => pool.query('DELETE FROM site_visits WHERE created_at < $1', [new Date(Date.now() - KEEP_DAYS * DAY)])
    .catch(err => console.error('[site-analytics] cleanup:', err.message));
  setTimeout(cleanup, 5 * 60 * 1000).unref();
  setInterval(cleanup, DAY).unref();
}

module.exports = { classifyPage, parseSource, isBot, device, browser, record, summarize, report, start, PAGE_LABELS };
