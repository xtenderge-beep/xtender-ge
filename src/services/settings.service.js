const pool = require('../config/db');

// Настройки приложения — простое key/value хранилище (app_settings). Пока один ключ
// (цена лида), но задел на будущее — не пишем отдельную таблицу под каждую настройку.
// Без кэша: читается нечасто (на диспатч заявки, не на каждый запрос), а лишний SELECT
// проще, чем возможная рассинхронизация кэша после правки в /admin/settings.

const LEAD_PRICE_KEY = 'lead_price_tetri';
const DEFAULT_LEAD_PRICE_TETRI = 50; // фолбэк, если строки в БД ещё нет

async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  );
}

async function getLeadPriceTetri() {
  const raw = await getSetting(LEAD_PRICE_KEY);
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEAD_PRICE_TETRI;
}

async function setLeadPriceTetri(tetri) {
  await setSetting(LEAD_PRICE_KEY, tetri);
}

module.exports = {
  getSetting,
  setSetting,
  getLeadPriceTetri,
  setLeadPriceTetri,
  DEFAULT_LEAD_PRICE_TETRI,
};
