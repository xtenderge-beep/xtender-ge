const pool = require('../config/db');
const translation = require('./translation.service');

// Догонка перевода заявок. Обычно заявка переводится один раз при создании (order.controller
// announceConfirmed), но при сбое OpenRouter или нерабочем ключе она так и осталась бы без перевода,
// а заявка, исправленная заказчиком (orderRevision.resubmit), не переводится совсем. Исполнитель в
// этом случае не может сменить язык. Поэтому открытые заявки без полного перевода подбираются фоновым
// проходом при запуске и затем каждые 10 минут, сначала самые новые.

const LANGS = ['ka', 'ru', 'en'];
const BATCH = 20;
const RECENT = 500;
const FIRST_RUN_MS = 60 * 1000;
const EVERY_MS = 10 * 60 * 1000;

function parse(value) {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Перевод полный, если есть оба языка, кроме исходного. Исходный определяем по тексту: source_lang
// после правки заказчиком содержит язык страницы, а не текста.
function isTranslated(row) {
  if (!row.description || !String(row.description).trim()) return true;
  const source = translation.detectLang(row.description);
  const t = parse(row.description_translations);
  return LANGS.filter(lang => lang !== source).every(lang => t[lang]);
}

// Сохраняем, только если текст за это время не поменялся: иначе перевод старого текста лёг бы поверх нового.
// Уже готовый язык остаётся, если второй вызов модели не удался. Запись на исходном языке убираем: на странице
// она заменила бы оригинал заказчика (такая могла остаться у заявок, чей язык раньше определялся иначе).
async function translateOrder(row) {
  const result = await translation.translateOrder(row.description);
  if (!result) return false;
  const merged = { ...parse(row.description_translations), ...result.translations };
  delete merged[result.sourceLang];
  const saved = await pool.query('UPDATE orders SET source_lang=$1, description_translations=$2::jsonb WHERE id=$3 AND description=$4 RETURNING id',
    [result.sourceLang, JSON.stringify(merged), row.id, row.description]);
  return saved.rows.length > 0;
}

async function backfill(limit = BATCH) {
  const rows = (await pool.query(`SELECT id, description, description_translations FROM orders
    WHERE status IN ('pending_review', 'new') AND description IS NOT NULL AND description <> ''
    ORDER BY id DESC LIMIT ${RECENT}`)).rows;
  const pending = rows.filter(row => !isTranslated(row)).slice(0, limit);
  let done = 0;
  for (const row of pending) {
    try { if (await translateOrder(row)) done++; } catch (err) { console.error('[order-translation]', row.id, err.message); }
  }
  if (pending.length) console.log(`[order-translation] переведено ${done} из ${pending.length}`);
  return { pending: pending.length, done };
}

function start() {
  if (!process.env.OPENROUTER_API_KEY) return;
  const run = () => backfill().catch(err => console.error('[order-translation] backfill:', err.message));
  setTimeout(run, FIRST_RUN_MS).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { isTranslated, translateOrder, backfill, start };
