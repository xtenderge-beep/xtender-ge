const pool = require('../config/db');
const siteAnalytics = require('./siteAnalytics.service');
const { displayName } = require('../config/providerName');
const { localizedPath } = require('../config/seo');

// Источники заявок (/admin/sources). Площадка — место, где размещена ссылка: пост в группе, сайт,
// листовка. У площадки своя ссылка /go/<code>; она ведёт на выбранную страницу с меткой
// utm_source=<code>. По метке сайт сам считает визиты (site_visits.source), а форма заявки
// записывает её в заявку (orders.source). Источник пишется у каждой заявки с формы, не только по
// ссылкам площадок: без метки это сайт, с которого пришли (Google, Facebook), или прямой заход.
const LANGS = ['ka', 'ru', 'en'];
const LANG_NAMES = { ka: 'грузинский', ru: 'русский', en: 'английский' };
const HOME = '/';
const CODE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Код для ссылки: название латиницей, только буквы, цифры и дефис.
function codeFrom(name) {
  return displayName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'source';
}

// Куда может вести ссылка: главная и включённые страницы задач — на тех языках, на которых они есть.
async function pageOptions() {
  const landings = await require('./landingPage.service').published();
  return [{ path: HOME, label: 'Главная', languages: LANGS },
    ...landings.map(page => ({ path: '/s/' + page.slug, label: 'Страница «' + page.admin_name + '»', languages: page.languages }))];
}

const cleanName = value => {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120) throw fail('Назовите площадку: от 2 до 120 знаков.');
  return name;
};

async function list() {
  return (await pool.query('SELECT * FROM traffic_sources ORDER BY created_at DESC, id DESC')).rows;
}

async function create({ name, path, lang }) {
  name = cleanName(name);
  const page = (await pageOptions()).find(option => option.path === (path || HOME));
  if (!page) throw fail('Такой страницы нет. Выберите страницу из списка.');
  if (!page.languages.includes(lang)) throw fail(page.label + ' не заполнена на этом языке: ' + LANG_NAMES[lang] + '. Выберите другой язык или страницу.');
  const base = codeFrom(name);
  // Код занят — добавляем номер; гонку двух одинаковых названий ловит уникальный ключ.
  for (let n = 1; n <= 50; n++) {
    const code = n === 1 ? base : base + '-' + n;
    if ((await pool.query('SELECT 1 FROM traffic_sources WHERE code=$1', [code])).rows.length) continue;
    try {
      return (await pool.query('INSERT INTO traffic_sources(code,name,path,lang) VALUES($1,$2,$3,$4) RETURNING *', [code, name, page.path, lang])).rows[0];
    } catch (error) { if (error.code !== '23505') throw error; }
  }
  throw fail('Слишком много площадок с таким названием. Назовите иначе.');
}

async function rename(id, name) {
  return (await pool.query('UPDATE traffic_sources SET name=$2 WHERE id=$1 RETURNING *', [Number(id), cleanName(name)])).rows[0] || null;
}

// Удаление убирает только название: ссылка продолжает вести на сайт, а визиты и заявки по её
// метке остаются в «Остальных источниках» под кодом.
async function remove(id) {
  await pool.query('DELETE FROM traffic_sources WHERE id=$1', [Number(id)]);
}

const landingUrl = source => localizedPath(source.lang, source.path) + '?utm_source=' + source.code + '&utm_medium=social';

// Куда вести посетителя ссылки /go/<code>. Неизвестный или удалённый код — на главную с той же
// меткой: размещённая ссылка не должна стать тупиком, а её визиты и заявки по-прежнему видны.
async function target(code) {
  code = String(code || '').toLowerCase();
  if (!CODE.test(code)) return HOME;
  const source = (await pool.query('SELECT * FROM traffic_sources WHERE code=$1', [code])).rows[0];
  return landingUrl(source || { code, path: HOME, lang: 'ka' });
}

// Название источника заявки для админки. null — источник не записан.
function label(value, sources) {
  if (value === null || value === undefined) return null;
  if (value === '') return siteAnalytics.DIRECT;
  return sources.find(source => source.code === value)?.name || value;
}

// Таблица за период: по каждому источнику визиты, подтверждённые заявки, из них разосланные и с
// откликом (нажатие «позвонить» или WhatsApp). Тестовые заявки считаются отдельно.
async function report(window) {
  const from = new Date(window.start), to = new Date(window.end);
  const [sources, visits, orders, contacts] = await Promise.all([
    list(),
    siteAnalytics.visitsBySource(window.start, window.end),
    pool.query(`SELECT id, source, origin, is_technical, first_dispatched_at FROM orders
      WHERE status <> 'unverified' AND COALESCE(confirmed_at, created_at) >= $1 AND COALESCE(confirmed_at, created_at) < $2`, [from, to]),
    pool.query("SELECT order_id FROM order_views WHERE event_type IN ('call', 'whatsapp') GROUP BY order_id"),
  ]);
  const contacted = new Set(contacts.rows.map(row => Number(row.order_id)));
  const rows = new Map();
  const row = (key, name) => {
    if (!rows.has(key)) rows.set(key, { key, name, visits: null, orders: 0, dispatched: 0, contacted: 0, tests: 0 });
    return rows.get(key);
  };
  for (const source of sources) Object.assign(row(source.code, source.name), { source, visits: 0 });
  for (const [name, count] of visits) row(name, name).visits = count;
  const MANAGER = '\u0000manager', UNKNOWN = '\u0000unknown';
  for (const order of orders.rows) {
    const bucket = order.source === null
      ? (order.origin && order.origin !== 'self' ? row(MANAGER, 'Оформлены менеджером или оператором') : row(UNKNOWN, 'Источник не записан'))
      : row(order.source === '' ? siteAnalytics.DIRECT : order.source, label(order.source, sources));
    if (order.is_technical) { bucket.tests++; continue; }
    bucket.orders++;
    if (order.first_dispatched_at) bucket.dispatched++;
    if (contacted.has(Number(order.id))) bucket.contacted++;
  }
  const all = [...rows.values()];
  return {
    placements: all.filter(item => item.source),
    others: all.filter(item => !item.source).sort((a, b) => b.orders - a.orders || (b.visits || 0) - (a.visits || 0) || String(a.name).localeCompare(String(b.name), 'ru')),
  };
}

module.exports = { LANGS, LANG_NAMES, codeFrom, pageOptions, list, create, rename, remove, landingUrl, target, label, report };
