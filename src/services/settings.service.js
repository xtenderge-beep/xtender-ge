const pool = require('../config/db');

// Настройки приложения — простое key/value хранилище (app_settings). Пока один ключ
// (цена лида), но задел на будущее — не пишем отдельную таблицу под каждую настройку.
// Без кэша: читается нечасто (на диспатч заявки, не на каждый запрос), а лишний SELECT
// проще, чем возможная рассинхронизация кэша после правки в /admin/settings.

const LEAD_PRICE_KEY = 'lead_price_tetri';
const DEFAULT_LEAD_PRICE_TETRI = 50; // фолбэк, если строки в БД ещё нет

// Цена за раскрытие номера в публичном каталоге (клиент звонит мастеру напрямую, минуя
// подачу заявки) — отдельный канал монетизации от цены лида с рассылки.
const CATALOG_CALL_PRICE_KEY = 'catalog_call_price_tetri';
const DEFAULT_CATALOG_CALL_PRICE_TETRI = 50;

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

async function getCatalogCallPriceTetri() {
  const raw = await getSetting(CATALOG_CALL_PRICE_KEY);
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CATALOG_CALL_PRICE_TETRI;
}

async function setCatalogCallPriceTetri(tetri) {
  await setSetting(CATALOG_CALL_PRICE_KEY, tetri);
}

const VAN_SIZE_THRESHOLDS_KEY = 'van_size_thresholds';

// Пороги S/M/L/XL/XXL в см — по умолчанию из serviceTypes.VAN_SIZES (см. её же
// комментарий: источник — тариф «Грузовой» Яндекса), но админ может поправить числа
// из /admin/categories/van без деплоя. Буквы и их порядок не меняются отсюда —
// только что каждая буква значит в см (см. schema.sql: masters_vehicle_size_check
// и order_dispatches_vehicle_size_check жёстко перечисляют сами буквы).
async function getVanSizeThresholds() {
  const { VAN_SIZES } = require('../config/serviceTypes');
  const raw = await getSetting(VAN_SIZE_THRESHOLDS_KEY);
  if (!raw) return VAN_SIZES;
  try {
    const saved = JSON.parse(raw);
    return VAN_SIZES.map(def => {
      const override = saved[def.code];
      const valid = override && ['length', 'width', 'height'].every(k => Number.isFinite(Number(override[k])) && Number(override[k]) > 0);
      return valid ? { code: def.code, length: Number(override.length), width: Number(override.width), height: Number(override.height) } : def;
    });
  } catch {
    return VAN_SIZES; // повреждённое значение в БД — не роняем страницу, просто дефолт
  }
}

async function setVanSizeThresholds(thresholds) {
  const { VAN_SIZE_ORDER } = require('../config/serviceTypes');
  const clean = {};
  for (const code of VAN_SIZE_ORDER) {
    const t = thresholds?.[code];
    const length = Number(t?.length), width = Number(t?.width), height = Number(t?.height);
    if (![length, width, height].every(n => Number.isFinite(n) && n >= 1 && n <= 2000)) {
      throw Object.assign(new Error(`Некорректные размеры для «${code}»: укажите длину/ширину/высоту от 1 до 2000 см.`), { status: 400 });
    }
    clean[code] = { length, width, height };
  }
  await setSetting(VAN_SIZE_THRESHOLDS_KEY, JSON.stringify(clean));
}

async function getWelcomeBonusTetri() {
  const value = Number(await getSetting('welcome_bonus_tetri', '0'));
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}
async function setWelcomeBonusTetri(tetri) {
  if (!Number.isSafeInteger(tetri) || tetri < 0 || tetri > 100000) throw new Error('Invalid welcome bonus');
  await setSetting('welcome_bonus_tetri', tetri);
}
module.exports = {
  getWelcomeBonusTetri, setWelcomeBonusTetri,
  getSetting,
  setSetting,
  getLeadPriceTetri,
  setLeadPriceTetri,
  getCatalogCallPriceTetri,
  setCatalogCallPriceTetri,
  getVanSizeThresholds,
  setVanSizeThresholds,
  DEFAULT_LEAD_PRICE_TETRI,
  DEFAULT_CATALOG_CALL_PRICE_TETRI,
};
