// Мини-страница компании (docs/company-pages.md).
// До подтверждения: закрытый предпросмотр /company/preview/<token> для компании из «Компаний для обзвона» и тот же
// блок на странице анкеты /c/<token> — «так будет выглядеть ваша страница». Не индексируется.
// После подтверждения кодом и модерации: публичная страница /company/<public_slug> исполнителя — описание, услуги,
// одобренные отзывы, кнопка заявки; есть в карте сайта. Номер на странице не показывается: клиент оставляет заявку,
// а номер открывает через каталог, как у всех исполнителей.
const crypto = require('crypto');
const pool = require('../config/db');
const COPY = require('../config/company-page-copy');
const { displayName } = require('../config/providerName');
const { localizedPath } = require('../config/seo');
const { BUILT_IN } = require('./servicePages.service');

const LANGS = ['ka', 'ru', 'en'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
// Порог качества: поиску открываем только страницу со своим содержанием — описанием компании не короче
// MIN_OWN_TEXT знаков (не собранным из наших общих фраз) или хотя бы одним одобренным отзывом. Иначе страница
// работает для клиентов по ссылке, но noindex и не в карте сайта: десятки почти одинаковых страниц Google считает
// шаблонными, и это бьёт по всему сайту.
const MIN_OWN_TEXT = 120;
const ownText = (description) => String(description || '').replace(/\s+/g, ' ').trim();
const isIndexable = (description, reviewCount) => ownText(description).length >= MIN_OWN_TEXT || reviewCount > 0;

const json = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return fallback; } }
  return value;
};

function baseSlug(name, website) {
  let raw = '';
  if (website) { try { raw = new URL(website).hostname.replace(/^www\./, '').split('.')[0]; } catch (_) { raw = ''; } }
  if (!raw) raw = displayName(name || '');
  return raw.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'company';
}

async function slugTaken(slug, { exceptProspect = null } = {}) {
  const p = (await pool.query('SELECT id FROM outreach_prospects WHERE slug = $1', [slug])).rows.filter(r => r.id !== exceptProspect);
  const m = (await pool.query('SELECT id FROM masters WHERE public_slug = $1', [slug])).rows;
  return p.length > 0 || m.length > 0;
}

async function uniqueSlug(name, website, opts) {
  const base = baseSlug(name, website);
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!await slugTaken(slug, opts)) return slug;
  }
  return `${base}-${crypto.randomInt(1e6)}`;
}

const newPreviewToken = () => Array.from({ length: 20 }, () => TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)]).join('');

// Адрес и ссылка предпросмотра для всех компаний списка, у кого их ещё нет.
async function ensureProspectPages() {
  const rows = (await pool.query('SELECT id, name, website, slug, preview_token FROM outreach_prospects WHERE slug IS NULL OR preview_token IS NULL')).rows;
  for (const row of rows) {
    const slug = row.slug || await uniqueSlug(row.name, row.website, { exceptProspect: row.id });
    await pool.query('UPDATE outreach_prospects SET slug = $2, preview_token = $3 WHERE id = $1', [row.id, slug, row.preview_token || newPreviewToken()]);
  }
}

function serviceHref(code, lang) {
  const head = BUILT_IN[code];
  return localizedPath(lang, head ? `/s/${head}-tbilisi` : '/');
}

// Данные для шаблона. Описание — то, что компания написала (или подтвердила); если пусто — собираем из услуг.
const MONTHS = {
  ka: ['იანვრის', 'თებერვლის', 'მარტის', 'აპრილის', 'მაისის', 'ივნისის', 'ივლისის', 'აგვისტოს', 'სექტემბრის', 'ოქტომბრის', 'ნოემბრის', 'დეკემბრის'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const monthYear = (date, lang) => { const d = new Date(date); return Number.isNaN(d.getTime()) ? null : `${MONTHS[lang][d.getMonth()]} ${d.getFullYear()}`; };
const { EXTRAS, DISTRICTS, LANGUAGE_NAMES } = require('../config/company-page-terms');

// Алфавит текста: ka/ru/en по преобладающим буквам; без букв (цифры, «₾») — null, такой текст годится для любой страницы.
function scriptLang(text) {
  const s = String(text || ''), count = re => (s.match(re) || []).length;
  const ka = count(/[\u10A0-\u10FF]/g), ru = count(/[\u0400-\u04FF]/g), en = count(/[A-Za-z]/g);
  if (!ka && !ru && !en) return null;
  if (ka >= ru && ka >= en) return 'ka';
  return ru >= en ? 'ru' : 'en';
}
const fitsLang = (text, lang) => { const l = scriptLang(text); return l === null || l === lang; };
const norm = v => String(v || '').trim().toLowerCase();
// Слово из словаря (доп. услуга, район) — на языке страницы; незнакомое — только если тот же алфавит.
function localize(values, dict, lang) {
  const out = [];
  for (const raw of values || []) {
    const v = norm(raw);
    if (!v) continue;
    const hit = dict.find(d => [d.ka, d.ru, d.en, ...(d.also || [])].some(x => norm(x) === v));
    const shown = hit ? hit[lang] : fitsLang(raw, lang) ? String(raw).trim() : null;
    if (shown && !out.includes(shown)) out.push(shown);
  }
  return out;
}

// description — уже на языке страницы (или пусто): перевод выбирает bySlug, предпросмотр — по алфавиту.
// indexText — описание в оригинале для порога качества. similar — похожие компании (ссылки).
function model({ name, description = '', indexText = null, services = [], other_services = [], districts = [], lang = 'ka', reviews = [], slug = null,
  preview = false, since = null, languages = [], priceText = '', similar = [] }) {
  lang = LANGS.includes(lang) ? lang : 'ka';
  const copy = COPY[lang];
  const items = services.filter(code => copy.services[code]).map(code => ({ code, title: copy.services[code][0], text: copy.services[code][1], href: serviceHref(code, lang) }));
  const intro = String(description || '').trim() || items.map(i => i.text).join(' ');
  const extras = localize(other_services, EXTRAS, lang).slice(0, 12), areas = localize(districts, DISTRICTS, lang).slice(0, 20);
  const price = fitsLang(priceText, lang) ? String(priceText || '').trim() : '';
  const main = items[0] ? items[0].code : 'movers';
  const ratings = reviews.map(r => Number(r.rating)).filter(Boolean);
  const avg = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null;
  const label = items.map(i => i.title).slice(0, 2).join(', ');
  const allLabel = items.map(i => i.title).join(', ');
  const dist = [5, 4, 3, 2, 1].map(star => ({ star, n: ratings.filter(r => r === star).length }));
  const crumbs = [{ name: copy.home, href: localizedPath(lang, '/') }];
  if (items[0]) crumbs.push({ name: `${items[0].title} — ${copy.area}`, href: items[0].href });
  crumbs.push({ name, href: slug ? localizedPath(lang, '/company/' + slug) : null });
  return {
    lang, copy, name, slug, preview, intro, items, extras, districts: areas,
    indexable: !preview && isIndexable(indexText === null ? description : indexText, reviews.length),
    summary: copy.summary({ name, label: allLabel, districts: areas.join(', '), price, avg, n: ratings.length }),
    faq: copy.faq({ name, label: allLabel || copy.area, extras: extras.join(', '), price, districts: areas.join(', '), cta: copy.cta }),
    similar,
    title: copy.seoTitle(name, label),
    metaDescription: copy.seoDescription(name, label.toLowerCase(), avg ? copy.ratingLine(avg, ratings.length) : '').slice(0, 160),
    since: since ? monthYear(since, lang) : null, languages: languages.filter(code => LANGUAGE_NAMES[lang][code]).map(code => LANGUAGE_NAMES[lang][code]),
    priceText: price, dist, crumbs,
    // Заявка с кнопки помечается компанией: модератор видит, откуда клиент, и компания идёт первой в списке рассылки.
    ctaHref: serviceHref(main, lang) + (slug && !preview ? '?company=' + slug : ''),
    reviews: reviews.map(r => ({ rating: Number(r.rating), comment: r.comment || '', date: r.created_at })), avg,
  };
}

async function byPreviewToken(token, lang) {
  if (typeof token !== 'string' || !/^[a-z2-9]{20}$/.test(token)) return null;
  const row = (await pool.query('SELECT * FROM outreach_prospects WHERE preview_token = $1', [token])).rows[0];
  if (!row) return null;
  // Описание с сайта компании показываем только на странице того же алфавита.
  return model({ name: row.name, description: fitsLang(row.description, lang) ? row.description : '', services: json(row.services, []),
    other_services: json(row.other_services, []), lang, slug: row.slug, preview: true });
}

async function activeMaster(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const m = (await pool.query('SELECT * FROM masters WHERE public_slug = $1', [slug])).rows[0];
  if (!m || !m.is_active || m.is_banned || m.is_technical) return null;
  return m;
}

async function bySlug(slug, lang) {
  const m = await activeMaster(slug);
  if (!m) return null;
  const services = (await pool.query('SELECT service_type FROM master_services WHERE master_id = $1 ORDER BY id', [m.id])).rows.map(r => r.service_type);
  if (!services.length && m.category) services.push(m.category);
  const hint = json(m.signup_hint, {});
  const translations = json(m.description_translations, {});
  const reviews = (await pool.query('SELECT rating, comment, created_at FROM master_reviews WHERE master_id = $1 AND is_approved = true ORDER BY created_at DESC LIMIT 50', [m.id])).rows;
  // Описание на языке страницы: перевод или оригинал того же языка. Перевода ещё нет (переводчик догоняет раз в час) —
  // вместо чужого языка текст из услуг.
  const source = LANGS.includes(m.description_source_lang) ? m.description_source_lang : scriptLang(m.description);
  const description = translations[lang] || (source === lang || source === null ? m.description : '');
  return model({ name: require('../config/providerName').resolve(m) || m.name, description, indexText: m.description, services,
    other_services: hint.other_services || [], districts: hint.districts || [], lang, reviews, slug,
    since: m.created_at, languages: json(m.spoken_languages, []), priceText: m.price_text, similar: await similar(m.id, services, lang) });
}

// Похожие компании для перелинковки: опубликованные (прошли порог качества) с общей услугой, сначала с большим числом общих.
async function similar(masterId, services, lang, limit = 4) {
  if (!services.length) return [];
  const copy = COPY[LANGS.includes(lang) ? lang : 'ka'];
  const rows = (await pool.query('SELECT * FROM masters WHERE public_slug IS NOT NULL')).rows
    .filter(r => r.id !== masterId && r.is_active && !r.is_banned && !r.is_technical);
  const out = [];
  for (const r of rows) {
    const theirs = (await pool.query('SELECT service_type FROM master_services WHERE master_id = $1 ORDER BY id', [r.id])).rows.map(x => x.service_type);
    const shared = theirs.filter(code => services.includes(code));
    if (!shared.length) continue;
    const reviews = (await pool.query('SELECT COUNT(*)::int AS n FROM master_reviews WHERE master_id = $1 AND is_approved = true', [r.id])).rows[0].n;
    if (!isIndexable(r.description, reviews)) continue;
    out.push({ name: require('../config/providerName').resolve(r) || r.name, href: localizedPath(lang, '/company/' + r.public_slug), shared: shared.length,
      services: theirs.filter(code => copy.services[code]).map(code => copy.services[code][0]).join(' · ') });
  }
  return out.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name)).slice(0, limit);
}

// Заявка с кнопки страницы компании (?company=<slug>): id исполнителя, если его страница публична.
async function masterIdBySlug(slug) {
  const m = await activeMaster(slug);
  return m ? m.id : null;
}

// В карту сайта — только страницы, прошедшие порог качества.
async function published() {
  const rows = (await pool.query('SELECT id, public_slug, description, is_active, is_banned, is_technical FROM masters WHERE public_slug IS NOT NULL')).rows;
  const out = [];
  for (const r of rows.filter(r => r.is_active && !r.is_banned && !r.is_technical)) {
    const reviews = (await pool.query('SELECT COUNT(*)::int AS n FROM master_reviews WHERE master_id = $1 AND is_approved = true', [r.id])).rows[0].n;
    if (isIndexable(r.description, reviews)) out.push(r.public_slug);
  }
  return out;
}

// После подтверждения анкеты: адрес страницы переходит исполнителю, если он ещё свободен.
async function claimSlug(masterId, slug) {
  if (!slug || !SLUG_RE.test(slug)) return null;
  const taken = (await pool.query('SELECT id FROM masters WHERE public_slug = $1', [slug])).rows[0];
  if (taken && taken.id !== masterId) return null;
  await pool.query('UPDATE masters SET public_slug = $2 WHERE id = $1', [masterId, slug]);
  return slug;
}

module.exports = { MIN_OWN_TEXT, isIndexable, LANGS, SLUG_RE, scriptLang, baseSlug, uniqueSlug, ensureProspectPages, model, byPreviewToken, bySlug, similar,
  masterIdBySlug, published, claimSlug };
