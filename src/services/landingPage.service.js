// Страницы под рекламу и поиск: одна задача заказчика — одна страница /s/<slug>.
// Хранятся в landing_pages и правятся в /admin/landings; три начальные (config/landing-seed.js)
// записываются один раз, после чего удаление и правки администратора остаются в силе.
// Описание — docs/landing-pages.md.
const pool = require('../config/db');
const settingsService = require('./settings.service');
const orderService = require('./order.service');
const providerName = require('../config/providerName');
const { parseDocBody } = require('../config/legalTextFormat');

const LANGS = ['ka', 'ru', 'en'];
const LANG_NAMES = { ka: 'грузинском', ru: 'русском', en: 'английском' };
// Меньше этого числа называть размер «группы» незачем: экран показывает фразу без числа.
const MIN_GROUP = 5;
const SEEDED_KEY = 'landing_pages_seeded';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Поля текста на одном языке и их предельная длина.
const TEXT_LIMITS = {
  title: 120, accent: 60, post: 160, post_one: 160, post_plain: 160, choose: 160, fact1: 80, fact2: 120,
  placeholder: 240, seo_title: 120, seo_description: 320, article: 12000,
};
const FIELD_NAMES = {
  title: 'Заголовок', accent: 'Вторая часть заголовка', post: 'Фраза с числом', post_one: 'Фраза для чисел на 1',
  post_plain: 'Фраза без числа', choose: 'Вторая строка фразы', fact1: 'Первая строка под формой', fact2: 'Вторая строка под формой',
  placeholder: 'Пример в поле', seo_title: 'Заголовок вкладки', seo_description: 'Описание для поиска', article: 'Статья',
};
// Без этих полей первый экран на языке не собрать: язык считается незаполненным.
const REQUIRED = ['title', 'post', 'post_plain', 'choose', 'placeholder'];

const fail = message => Object.assign(new Error(message), { status: 400 });

// Склонение после числа: ru «из 21 грузчика», «из 52 грузчиков».
function countForm(count, lang) {
  if (lang === 'ru') return count % 10 === 1 && count % 100 !== 11 ? 'one' : 'many';
  return count === 1 ? 'one' : 'many';
}

let seeding = null;
// Начальные страницы пишутся один раз на базу. Отметка в app_settings, а не «таблица пуста»:
// иначе удаление последней страницы возвращало бы все три при следующем старте.
function ensureSeeded() {
  if (!seeding) seeding = (async () => {
    if (await settingsService.getSetting(SEEDED_KEY)) return;
    for (const page of require('../config/landing-seed')) {
      await pool.query(
        `INSERT INTO landing_pages (slug, admin_name, categories, content, sort_order) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         ON CONFLICT (slug) DO NOTHING`,
        [page.slug, page.admin_name, JSON.stringify(page.categories), JSON.stringify(page.content), page.sort_order]);
    }
    await settingsService.setSetting(SEEDED_KEY, '1');
  })().catch(error => { seeding = null; throw error; });
  return seeding;
}

async function list() {
  await ensureSeeded();
  return (await pool.query('SELECT * FROM landing_pages ORDER BY sort_order, id')).rows;
}
async function get(id) {
  await ensureSeeded();
  return Number.isInteger(Number(id)) && Number(id) > 0 ? (await pool.query('SELECT * FROM landing_pages WHERE id=$1', [Number(id)])).rows[0] || null : null;
}
async function getBySlug(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  await ensureSeeded();
  return (await pool.query('SELECT * FROM landing_pages WHERE slug=$1', [slug])).rows[0] || null;
}

// На каких языках страницу можно показать.
const available = (page, lang) => REQUIRED.every(field => String(page?.content?.[lang]?.[field] || '').trim());
const languages = page => LANGS.filter(lang => available(page, lang));

// Группы рассылки, которые можно считать: те же ключи, что у заявки (transport, movers, junk, …).
async function groupOptions() {
  return Object.entries(await require('./category.service').groups(true)).map(([key, label]) => ({ key, label }));
}

// «Группа» на первом экране: сколько исполнителей получат такую заявку сейчас и первые буквы их имён.
// Отбор тот же, что у настоящей рассылки (order.service getDispatchRecipients): активный профиль,
// разрешённые платные уведомления, баланса хватает, город. Исполнитель с двумя услугами считается раз.
async function audience(categories, cityId) {
  const result = { count: 0, initials: [] };
  try {
    const price = await settingsService.getLeadPriceTetri();
    // Заявки ещё нет: подставляем только то, что отбор читает из неё, — город.
    const scope = { id: 0, city_id: cityId || null, target_categories: [], requirements: {} };
    const members = new Map();
    for (const category of Array.isArray(categories) ? categories : []) {
      for (const master of await orderService.getDispatchRecipients(category, '', price, false, '', scope)) members.set(master.id, master);
    }
    const group = [...members.values()];
    result.count = group.length;
    result.initials = group.slice(0, 4).map(master => String(providerName.resolve(master) || '?').trim().charAt(0).toUpperCase());
  } catch (error) {
    // Страница не должна падать из-за подсчёта: без числа экран показывает фразу без него.
    console.error('Landing audience failed:', error.message);
  }
  return result;
}

// Всё, что нужно шаблону главной, чтобы показать страницу на языке lang.
async function view(page, lang, cityId) {
  const text = page.content[lang];
  const group = await audience(page.categories, cityId);
  const count = group.count >= MIN_GROUP ? group.count : 0;
  const phrase = !count ? text.post_plain : (countForm(count, lang) === 'one' && text.post_one) || text.post;
  return {
    slug: page.slug,
    count,
    initials: group.initials,
    title: text.title,
    accent: text.accent || '',
    // [до выделения, выделенное, после]; без скобок выделения нет.
    post: phrase.replace('{count}', count).split(/[\[\]]/),
    choose: text.choose,
    facts: [text.fact1, text.fact2].filter(Boolean),
    placeholder: text.placeholder,
    seoTitle: text.seo_title || [text.title, text.accent].filter(Boolean).join(' ') + ' | xtender.ge',
    seoDescription: text.seo_description || '',
    article: text.article_on && text.article ? parseDocBody(text.article) : [],
    languages: languages(page),
  };
}

const brackets = value => ({ open: (value.match(/\[/g) || []).length, close: (value.match(/\]/g) || []).length });
function checkPhrase(value, name, where, withCount) {
  const { open, close } = brackets(value);
  if (open > 1 || open !== close || (open && value.indexOf('[') > value.indexOf(']'))) throw fail(`${where}: «${name}» — квадратные скобки ставятся один раз, вокруг выделяемых слов.`);
  const has = value.includes('{count}');
  if (withCount && !has) throw fail(`${where}: в «${name}» нет {count} — на его место подставляется число исполнителей.`);
  if (!withCount && has) throw fail(`${where}: «${name}» показывается, когда исполнителей мало, поэтому {count} в ней не нужен.`);
}

async function normalize(input) {
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!SLUG.test(slug) || slug.length > 80) throw fail('Адрес: только латинские буквы, цифры и дефис между словами, например avejis-gadazidva.');
  const admin_name = String(input.admin_name || '').trim();
  if (!admin_name || admin_name.length > 120) throw fail('Укажите название страницы (до 120 знаков).');
  const allowed = new Set((await groupOptions()).map(group => group.key));
  const categories = [...new Set([].concat(input.categories || []).map(String))];
  if (categories.some(key => !allowed.has(key))) throw fail('Выбрана неизвестная группа исполнителей.');
  const sort = Number(input.sort_order);
  const sort_order = Number.isInteger(sort) && sort >= 0 && sort <= 10000 ? sort : 100;

  const content = {};
  for (const lang of LANGS) {
    const raw = input.content?.[lang] || {}, where = 'На ' + LANG_NAMES[lang];
    const text = {};
    for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
      const value = String(raw[field] || '').replace(/\r\n/g, '\n').trim();
      if (value.length > limit) throw fail(`${where}: «${FIELD_NAMES[field]}» длиннее ${limit} знаков.`);
      text[field] = value;
    }
    text.article_on = raw.article_on === true || raw.article_on === 'on';
    const filled = Object.keys(TEXT_LIMITS).some(field => text[field]);
    const missing = REQUIRED.filter(field => !text[field]);
    if (filled && missing.length) throw fail(`${where} заполните: ${missing.map(field => '«' + FIELD_NAMES[field] + '»').join(', ')} — или очистите все поля этого языка.`);
    if (filled) {
      checkPhrase(text.post, FIELD_NAMES.post, where, true);
      if (text.post_one) checkPhrase(text.post_one, FIELD_NAMES.post_one, where, true);
      checkPhrase(text.post_plain, FIELD_NAMES.post_plain, where, false);
    }
    content[lang] = text;
  }
  if (!languages({ content }).length) throw fail('Заполните страницу хотя бы на одном языке.');
  return { slug, admin_name, categories, sort_order, content, is_active: input.is_active === true || input.is_active === 'on' };
}

async function save(id, input) {
  await ensureSeeded();
  const page = await normalize(input);
  const values = [page.slug, page.admin_name, JSON.stringify(page.categories), JSON.stringify(page.content), page.is_active, page.sort_order];
  try {
    const result = id
      ? await pool.query('UPDATE landing_pages SET slug=$1, admin_name=$2, categories=$3::jsonb, content=$4::jsonb, is_active=$5, sort_order=$6, updated_at=NOW() WHERE id=$7 RETURNING *', [...values, Number(id)])
      : await pool.query('INSERT INTO landing_pages (slug, admin_name, categories, content, is_active, sort_order) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6) RETURNING *', values);
    if (!result.rows[0]) throw fail('Страница не найдена.');
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505' || /unique|duplicate/i.test(error.message || '')) throw fail('Страница с таким адресом уже есть.');
    throw error;
  }
}

async function remove(id) {
  await ensureSeeded();
  await pool.query('DELETE FROM landing_pages WHERE id=$1', [Number(id)]);
}

// Включённые страницы с языками, на которых они показываются: для карты сайта и ссылок на главной.
async function published() {
  return (await list()).filter(page => page.is_active).map(page => ({ ...page, languages: languages(page) })).filter(page => page.languages.length);
}

module.exports = { LANGS, MIN_GROUP, TEXT_LIMITS, FIELD_NAMES, REQUIRED, countForm, ensureSeeded, list, get, getBySlug, available, languages, groupOptions, audience, view, normalize, save, remove, published };
