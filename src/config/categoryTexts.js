// Описание категории и слова поиска — управляемые данные админки (service_categories.descriptions, .synonyms), ka/ru/en
// и грузинский латиницей. Прежние значения жили в коде: описания — в переводах (service_desc_<slug>_body), слова — в
// service-search-words.js. Пока строка не перенесена (NULL), действуют они; при старте category.service.migrateTexts
// переносит их один раз. Пустое значение из админки ({} или []) — осознанное «ничего», код его не подменяет.
const { translate } = require('./i18n');
const { SEARCH_WORDS } = require('./service-search-words');

const LANGS = ['ka', 'ru', 'en'];
const SYNONYM_KEYS = ['ka', 'ru', 'en', 'latin'];
// Строки слов в service-search-words.js: русский, грузинский, английский, грузинский латиницей.
const LINE = { ru: 0, ka: 1, en: 2, latin: 3 };
const LIMITS = { description: 600, phrase: 60, phrases: 80 };

const uniq = (list) => [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
const split = (text) => String(text || '').split(/\s+/);

function defaultDescriptions(slug) {
  return Object.fromEntries(LANGS.map((lang) => {
    const key = `service_desc_${slug}_body`;
    const text = translate(lang)(key);
    return [lang, text === key ? '' : text];
  }));
}

// Все слова групп, где участвует категория, и подписи их хэштегов: «переезд» остаётся и у грузчиков, и у перевозки.
function defaultSynonyms(slug) {
  const entries = SEARCH_WORDS.filter((entry) => entry.services.includes(slug));
  return Object.fromEntries(SYNONYM_KEYS.map((key) => [key, uniq(entries.flatMap((entry) => [
    ...split(entry.words[LINE[key]]), ...(key !== 'latin' && entry.tag?.[key] ? [entry.tag[key]] : []),
  ]))]));
}

const asObject = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

function descriptions(row) {
  const stored = row?.descriptions == null ? null : asObject(row.descriptions);
  const value = stored || defaultDescriptions(row?.slug);
  return Object.fromEntries(LANGS.map((lang) => [lang, typeof value[lang] === 'string' ? value[lang] : '']));
}

function synonyms(row) {
  const stored = row?.synonyms == null ? null : asObject(row.synonyms);
  const value = stored || defaultSynonyms(row?.slug);
  return Object.fromEntries(SYNONYM_KEYS.map((key) => [key, Array.isArray(value[key]) ? value[key] : []]));
}

// Все слова поиска категории одной строкой (для свёртки в токены).
function searchText(row) {
  return Object.values(synonyms(row)).flat().join(' ');
}

// Поля формы админки → значения для базы. Описание — до 600 знаков; слова — через запятую или с новой строки.
function parseInput(input, fail) {
  const out = { descriptions: {}, synonyms: {} };
  for (const lang of LANGS) {
    const text = typeof input['description_' + lang] === 'string' ? input['description_' + lang].replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
    if (text.length > LIMITS.description) throw fail(`Описание (${lang}): до ${LIMITS.description} символов.`);
    out.descriptions[lang] = text;
  }
  for (const key of SYNONYM_KEYS) {
    const raw = typeof input['synonyms_' + key] === 'string' ? input['synonyms_' + key] : '';
    const phrases = uniq(raw.split(/[,\n;]+/).map((s) => s.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ')));
    if (phrases.length > LIMITS.phrases) throw fail(`Слова поиска (${key}): не больше ${LIMITS.phrases}.`);
    if (phrases.some((p) => p.length > LIMITS.phrase)) throw fail(`Слова поиска (${key}): каждое до ${LIMITS.phrase} символов.`);
    out.synonyms[key] = phrases;
  }
  return out;
}

const touched = (input) => [...LANGS.map((lang) => 'description_' + lang), ...SYNONYM_KEYS.map((key) => 'synonyms_' + key)].some((name) => input[name] !== undefined);

module.exports = { LANGS, SYNONYM_KEYS, LIMITS, defaultDescriptions, defaultSynonyms, descriptions, synonyms, searchText, parseInput, touched };
