// Каталог для API v1: категории с поиском по описанию потребности, схема параметров заявки по категории, география,
// наличие исполнителей и версии каталога. Источник — тот же справочник услуг, что в /admin/categories
// (service_categories), и тот же словарь слов, что у поиска на главной (service-search-words.js): новая услуга из
// админки появляется здесь без правки кода. Серверного ИИ нет: поиск — нормализация (одна латиница для ka/ru/en)
// и совпадение по началу слова. Описание — docs/api-v1/README.md, раздел «Каталог».
const crypto = require('node:crypto');
const categoryService = require('./category.service');
const masterService = require('./master.service');
const settingsService = require('./settings.service');
const redis = require('../config/redis');
const search = require('../../public/js/service-search');
const { SEARCH_WORDS, FEATURE_TAGS } = require('../config/service-search-words');
const { NEED_WORDING } = require('../config/serviceTypes');
const { translate } = require('../config/i18n');
const units = require('../config/units');
const requestFields = require('../config/requestFields');
const { getBaseUrl } = require('../config/url');
const { PREFIX } = require('../config/apiV1');

const SUPPLY_TTL_MS = 5 * 60 * 1000;
const Q_MAX_LENGTH = 300;
const LINE_BY_LANG = { ru: 0, ka: 1, en: 2 };

// --- Версии ----------------------------------------------------------------------------------------------------
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const hash = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex').slice(0, 16);

// Версия схемы — от определения параметров заявки (и характеристик, из которых они могут выводиться), а не от подписей
// на языке ответа: правка в /admin/categories меняет её сама.
function schemaVersion(row, sizes) {
  const fields = (row.fields || []).map(({ need, ...field }) => field);
  return 'cs_' + hash({ slug: row.slug, kind: row.kind || 'service', request: requestFields.forCategory(row), fields,
    sizes: fields.some((f) => f.input === 'size') ? sizes : null });
}

// Слова поиска входят в версию каталога: их правка меняет выдачу так же, как новая услуга.
const WORDS_VERSION = hash({ SEARCH_WORDS, FEATURE_TAGS: FEATURE_TAGS.map(({ attribute, ...tag }) => tag) });

async function snapshot() {
  const [rows, sizes] = await Promise.all([categoryService.list(), settingsService.getVanSizeThresholds()]);
  const categories = rows.map((row) => ({ ...row, schema_version: schemaVersion(row, sizes) }));
  const version = 'cat_' + hash({ words: WORDS_VERSION, categories: categories.map((c) => ({
    slug: c.slug, names: [c.name_ka, c.name_ru, c.name_en], active: c.is_active, order: c.sort_order, icon: c.icon, schema: c.schema_version })) });
  return { categories, sizes, version, updatedAt: await versionSince(version) };
}

// Когда каталог в последний раз стал таким: время первого ответа с этой версией (Redis). Точной отметки правки
// в справочнике нет, а версия считается при каждом запросе, поэтому расхождение — не дольше одного запроса.
async function versionSince(version) {
  try {
    const raw = await redis.get('api_catalog_version');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && saved.version === version) return saved.since;
    const since = new Date().toISOString();
    await redis.set('api_catalog_version', JSON.stringify({ version, since }));
    return since;
  } catch { return new Date().toISOString(); }
}

// --- География --------------------------------------------------------------------------------------------------
const names = (row) => ({ ka: row.name_ka, ru: row.name_ru, en: row.name_en });

async function locationIndex() {
  const cities = await masterService.getWorkCities();
  const items = [{ id: 'country:GE', type: 'country', parent_id: null, names: { ka: 'საქართველო', ru: 'Грузия', en: 'Georgia' }, served: cities.some((c) => c.is_active), country_code: 'GE' }];
  for (const city of cities) {
    items.push({ id: 'city:' + city.slug, type: 'city', parent_id: 'country:GE', names: names(city), served: city.is_active, country_code: 'GE', _city: city });
    for (const district of await masterService.getDistrictsByCity(city.id)) {
      if (!district.slug) continue;
      items.push({ id: 'district:' + district.slug, type: 'district', parent_id: 'city:' + city.slug, names: names(district), served: city.is_active, country_code: 'GE', _city: city });
    }
  }
  return items;
}

const publicLocation = ({ _city, ...item }, lang) => ({ ...item, name: item.names[lang] || item.names.en });

async function resolveLocation(id) {
  if (typeof id !== 'string' || id.length > 80) return null;
  return (await locationIndex()).find((item) => item.id === id) || null;
}

async function locations({ q, parentId, lang }) {
  let items = await locationIndex();
  if (parentId) items = items.filter((item) => item.parent_id === parentId);
  if (q) {
    const asked = search.tokens(String(q).slice(0, 100), 2);
    items = items.filter((item) => {
      const words = search.tokens(Object.values(item.names).join(' ') + ' ' + item.id.split(':')[1].replace(/-/g, ' '), 2);
      return asked.length && asked.every((word) => words.some((candidate) => search.wordsMatch(word, candidate)));
    });
  }
  return items.map((item) => publicLocation(item, lang));
}

// --- Наличие исполнителей ------------------------------------------------------------------------------------------
// Сколько одобренных исполнителей каждой услуги в каталоге города — те же числа, что у страниц «услуга + город»
// и в /llms.txt. Это не обещание отклика: исполнитель может быть занят или отписаться от заявок.
let supplyCache = null;
async function supply() {
  if (supplyCache && supplyCache.until > Date.now()) return supplyCache;
  const byCity = new Map();
  for (const city of await masterService.getActiveCities()) {
    const counts = new Map();
    for (const master of await masterService.listMasters({ cityId: city.id })) {
      const serves = new Set([master.service_type, ...(master.services || []).map((s) => s.service_type)].filter(Boolean));
      serves.forEach((slug) => counts.set(slug, (counts.get(slug) || 0) + 1));
    }
    byCity.set(city.id, counts);
  }
  supplyCache = { byCity, checkedAt: new Date().toISOString(), until: Date.now() + SUPPLY_TTL_MS };
  return supplyCache;
}
function resetSupply() { supplyCache = null; }

async function availabilityFor(category, location) {
  if (!category.is_active) return { availability: { status: 'unsupported', reason: 'category_inactive' }, supply: null };
  if (!location) return { availability: { status: 'unknown', reason: 'location_not_specified' }, supply: null };
  if (location.type === 'country') return { availability: { status: 'unknown', reason: 'city_required' }, supply: null };
  if (!location.served) return { availability: { status: 'unsupported', reason: 'city_not_served' }, supply: null };
  const { byCity, checkedAt } = await supply();
  const count = byCity.get(location._city.id)?.get(category.slug) || 0;
  return { availability: { status: 'supported', reason: null },
    supply: { status: count ? 'providers_present' : 'none_known', provider_count: count, checked_at: checkedAt } };
}

// --- Поиск ------------------------------------------------------------------------------------------------------
function searchEntries(categories) {
  const active = new Set(categories.map((c) => c.slug));
  const entries = [...SEARCH_WORDS, ...FEATURE_TAGS.filter((tag) => tag.services)]
    .map((entry) => ({ services: entry.services.filter((s) => active.has(s)), words: search.tokens(entry.words.join(' ') + ' ' + Object.values(entry.tag || {}).join(' ')) }))
    .filter((entry) => entry.services.length);
  categories.forEach((c) => entries.push({ services: [c.slug], words: search.tokens([c.name_ka, c.name_ru, c.name_en].join(' ')) }));
  return entries;
}

// Слово запроса совпадает со словом справочника. Строже, чем поиск на главной: там подсказка по мере набора, здесь
// модель выбирает категорию для заявки. Слово из трёх букв — только целиком: иначе «car» находило «cargo» и
// «wardrobe» (после свёртки латиницы w → c, как грузинское წ).
function termMatches(token, candidate) {
  return token.length >= 4 ? search.wordsMatch(token, candidate) : token === candidate;
}

// Слова запроса по отдельности (как их написал человек) и категории, к которым каждое привело.
function matchQuery(q, categories) {
  const entries = searchEntries(categories);
  const matched = new Map();
  const words = String(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 40);
  for (const word of words) {
    const folded = search.tokens(word, 3);
    if (!folded.length) continue;
    for (const entry of entries) {
      if (!folded.some((token) => entry.words.some((candidate) => termMatches(token, candidate)))) continue;
      for (const slug of entry.services) {
        if (!matched.has(slug)) matched.set(slug, new Set());
        matched.get(slug).add(word);
      }
    }
  }
  return matched;
}

function synonyms(slug, lang) {
  const lines = [LINE_BY_LANG[lang], ...(lang === 'ka' ? [3] : [])];
  const words = SEARCH_WORDS.filter((entry) => entry.services.includes(slug))
    .flatMap((entry) => lines.flatMap((line) => String(entry.words[line] || '').split(/\s+/)))
    .filter(Boolean);
  return [...new Set(words)];
}

function description(slug, lang) {
  const key = `service_desc_${slug}_body`;
  const text = translate(lang)(key);
  return text === key ? null : text;
}

async function categoryView(category, lang, location, extra = {}) {
  const { availability, supply: supplyStatus } = await availabilityFor(category, location);
  return {
    id: category.slug,
    parent_id: null,
    kind: category.kind || 'service',
    name: category['name_' + lang] || category.name_en,
    names: names(category),
    language_used: category['name_' + lang] ? lang : 'en',
    description: description(category.slug, lang),
    synonyms: synonyms(category.slug, lang),
    // Состава работ («что входит / не входит») в справочнике нет: неизвестно, а не «ничего».
    included_services: null,
    excluded_services: null,
    active: category.is_active,
    icon: category.icon || null,
    schema_version: category.schema_version,
    schema_operation_id: 'getCategorySchema',
    schema_url: getBaseUrl() + PREFIX + '/categories/' + encodeURIComponent(category.slug) + '/schema',
    availability: { ...availability, location_id: location ? location.id : null },
    supply_status: supplyStatus || { status: 'unknown', provider_count: null, checked_at: null },
    ...extra,
  };
}

// Возвращает { snapshot, items, matchStatus } — список уже отсортирован, пагинацию делает контроллер.
async function searchCategories({ q, lang, kind, location, activeOnly = true }) {
  const snap = await snapshot();
  let categories = snap.categories.filter((c) => !activeOnly || c.is_active);
  if (kind) categories = categories.filter((c) => (c.kind || 'service') === kind);
  if (!q) {
    return { snapshot: snap, matchStatus: null,
      items: await Promise.all(categories.map((c) => categoryView(c, lang, location))) };
  }
  const matched = matchQuery(q, categories);
  const hits = categories.filter((c) => matched.has(c.slug))
    .sort((a, b) => matched.get(b.slug).size - matched.get(a.slug).size || a.sort_order - b.sort_order || (a.slug < b.slug ? -1 : 1));
  const items = await Promise.all(hits.map((c, i) => categoryView(c, lang, location, { matched_terms: [...matched.get(c.slug)], match_rank: i + 1 })));
  return { snapshot: snap, items, matchStatus: items.length === 0 ? 'none' : items.length === 1 ? 'matched' : 'ambiguous' };
}

// --- Схема параметров заявки --------------------------------------------------------------------------------------
// Параметры заявки — что заказчик называет в заявке (src/config/requestFields.js), отдельно от характеристик исполнителя.
// У параметра может быть правило подбора к характеристике исполнителя (x-xtender-maps-to). Обязательные для публикации —
// отмеченные в редакторе категории; у категории товаров обязательны позиции закупки.
const RULE_HELP = {
  provider_gte: 'Matched against the provider characteristic: the provider must have at least this value.',
  provider_eq: 'Matched against the provider characteristic: the provider must have exactly this value.',
  provider_flag: 'true means the customer needs it and the provider must have it. Leave the field out when the customer did not say; false only means "not required", never "no".',
};
const SIZE_SPEC = {
  ru: (s) => `кузов от ${s.length}×${s.width}×${s.height} см (Д×Ш×В)`,
  ka: (s) => `ძარა ${s.length}×${s.width}×${s.height} სმ-დან (სიგრძე×სიგანე×სიმაღლე)`,
  en: (s) => `cargo space from ${s.length}×${s.width}×${s.height} cm (L×W×H)`,
};

// Параметры, выведенные из характеристик услуги из админки, подписаны словами исполнителя; для заявки берём слова
// заказчика, где они есть (NEED_WORDING, отметка «Самосвал»).
const REQUEST_TITLES = {
  van: { tail_lift: { en: 'Tail lift needed', ka: 'საჭიროა ჰიდრობორტი' }, with_helpers: { en: 'Van that comes with loaders', ka: 'მანქანა მტვირთავებით' } },
  junk: { dump_body: { en: 'Dump truck needed', ka: 'საჭიროა თვითმცლელი' } },
};

function fieldTitle(category, field, lang) {
  if (!field.derived) return requestFields.label(field, lang);
  const need = field.need?.label || NEED_WORDING[category.slug]?.[field.key]?.label;
  if (lang === 'ru' && need) return need;
  if (REQUEST_TITLES[category.slug]?.[field.key]?.[lang]) return REQUEST_TITLES[category.slug][field.key][lang];
  const key = `svc_${category.slug}_${field.key}`;
  const fromDictionary = translate(lang)(key);
  return field.labels?.[lang] || (fromDictionary !== key ? fromDictionary : null) || field.labels?.ru || field.key;
}

function categorySchema(category, lang, sizes) {
  const properties = {};
  for (const field of requestFields.forCategory(category)) {
    const rule = field.maps_to?.rule;
    const base = { title: fieldTitle(category, field, lang),
      description: RULE_HELP[rule] || 'Information for providers; not used to choose recipients.',
      ...(field.maps_to ? { 'x-xtender-maps-to': { field: field.maps_to.field, rule } } : {}) };
    const unit = units.codeFor(field.unit);
    if (field.input === 'enum') {
      const sized = field.maps_to?.field === 'size';
      properties[field.key] = { ...base, type: 'string', oneOf: (field.options || []).map((value) => {
        const spec = sized ? sizes.find((s) => s.code === value) : null;
        const title = spec ? `${value} — ${(SIZE_SPEC[lang] || SIZE_SPEC.en)(spec)}`
          : field.optionLabels?.[value]?.[lang] || field.optionLabels?.[value]?.ru
            || (unit ? `${value} ${units.view(units.UNITS.find((u) => u.code === unit), lang).short}` : value);
        return { const: value, title };
      }) };
    } else if (field.input === 'number') {
      properties[field.key] = { ...base, type: 'number', ...(field.min != null ? { minimum: field.min } : {}), ...(field.max != null ? { maximum: field.max } : {}) };
    } else if (field.input === 'bool') {
      properties[field.key] = { ...base, type: 'boolean' };
    } else if (field.input === 'date') {
      properties[field.key] = { ...base, type: 'string', format: 'date' };
    } else {
      properties[field.key] = { ...base, type: 'string', maxLength: 500 };
    }
    if (unit) properties[field.key]['x-xtender-unit'] = unit;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: getBaseUrl() + PREFIX + '/categories/' + encodeURIComponent(category.slug) + '/schema#' + category.schema_version,
    title: category['name_' + lang] || category.name_en,
    description: 'Parameters a customer can state for a request in this category. An absent value means unknown; required_for_publish lists what publishing needs.',
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

function requiredForPublish(category) {
  return [...requestFields.requiredKeys(category), ...(category.kind === 'goods' ? ['items'] : [])];
}

async function getSchema(slug, lang) {
  const snap = await snapshot();
  const category = snap.categories.find((c) => c.slug === slug);
  if (!category) return null;
  return {
    snapshot: snap,
    body: {
      category_id: category.slug,
      kind: category.kind || 'service',
      active: category.is_active,
      schema_version: category.schema_version,
      catalog_version: snap.version,
      json_schema: categorySchema(category, lang, snap.sizes),
      required_for_publish: requiredForPublish(category),
      // Позиции закупки: у категории товаров — обязательны (название, количество, единица), замена — только если
      // заказчик разрешил её у позиции.
      item_rules: category.kind === 'goods'
        ? { items_required: true, item_fields: requestFields.ITEM_FIELDS, quantity: 'decimal string', unit: 'unit code (listUnits)', substitutions: 'only where substitutions_allowed = true' }
        : { items_required: false, item_fields: requestFields.ITEM_FIELDS },
    },
  };
}

module.exports = {
  Q_MAX_LENGTH, snapshot, schemaVersion, searchCategories, getSchema, categorySchema, requiredForPublish, locations, resolveLocation, supply, resetSupply,
  matchQuery, stable, hash,
};
