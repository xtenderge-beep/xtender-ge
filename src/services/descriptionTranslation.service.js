const pool = require('../config/db');
const translation = require('./translation.service');

// Автоперевод описаний исполнителей на ka/ru/en. Каталог показывает перевод на языке
// страницы (master.service.descriptionFor), а без перевода — оригинал, поэтому описание
// должно переводиться при любом его изменении, а не только когда его правит менеджер:
//  - после регистрации и правки админом — в фоне (queue), сохранение не ждёт перевода;
//  - всё, что осталось без перевода (старые профили, временный сбой OpenRouter), —
//    фоновым проходом при запуске и затем раз в час (start/backfill).
// Правка менеджером (managerPortal.updateDescription) переводит сама и синхронно.

const LANGS = ['ka', 'ru', 'en'];
const BATCH = 50;
const FIRST_RUN_MS = 60 * 1000;
const EVERY_MS = 60 * 60 * 1000;

function parse(value) {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Перевод полный, если есть оба языка, кроме исходного.
function isTranslated(row) {
  if (!row.description || !String(row.description).trim()) return true;
  const source = LANGS.includes(row.description_source_lang) ? row.description_source_lang : translation.detectLang(row.description);
  const t = parse(row.description_translations);
  return LANGS.filter(lang => lang !== source).every(lang => t[lang]);
}

// Переводит текущее описание и сохраняет, только если описание за это время не поменялось:
// иначе перевод старого текста лёг бы поверх нового.
async function translateMaster(masterId) {
  const row = (await pool.query('SELECT id, description, description_source_lang, description_translations FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!row || isTranslated(row)) return false;
  const result = await translation.translateProviderDescription(row.description, row.description_source_lang);
  if (!result) return false;
  const saved = await pool.query('UPDATE masters SET description_source_lang=$1, description_translations=$2::jsonb WHERE id=$3 AND description=$4 RETURNING id',
    [result.sourceLang, JSON.stringify(result.translations), masterId, row.description]);
  return saved.rows.length > 0;
}

// Для контроллеров: не ждём и не роняем запрос — не переведённое подхватит backfill.
function queue(masterId) {
  if (!masterId) return;
  translateMaster(masterId).catch(err => console.error('[description-translation]', masterId, err.message));
}

async function backfill(limit = BATCH) {
  const rows = (await pool.query("SELECT id, description, description_source_lang, description_translations FROM masters WHERE description IS NOT NULL AND description <> '' ORDER BY id")).rows;
  const pending = rows.filter(row => !isTranslated(row)).slice(0, limit);
  let done = 0;
  for (const row of pending) {
    try { if (await translateMaster(row.id)) done++; } catch (err) { console.error('[description-translation]', row.id, err.message); }
  }
  if (pending.length) console.log(`[description-translation] переведено ${done} из ${pending.length}`);
  return { pending: pending.length, done };
}

function start() {
  if (!process.env.OPENROUTER_API_KEY) return;
  const run = () => backfill().catch(err => console.error('[description-translation] backfill:', err.message));
  setTimeout(run, FIRST_RUN_MS).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { isTranslated, translateMaster, queue, backfill, start };
