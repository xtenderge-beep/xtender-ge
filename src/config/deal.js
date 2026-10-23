// Общие правила сделки (заявка → предложения → выбор → подтверждение) для сайта и API. Описание — docs/api-v1/WORKFLOWS.md.
// Решения владельца 2026-10-23 (docs/api-v1/BACKEND_AUDIT.md, раздел 12): сбор по умолчанию 24 часа, но не позже начала
// работ; подтверждение выбранным исполнителем — до 24 часов и обязательно раньше начала работ.

class DealError extends Error {
  // status — HTTP-код; code — стабильный код для API и сайта; fields — ошибки полей; details — доп. поля ответа.
  constructor(status, code, message, { fields, details, retryable = false } = {}) {
    super(message);
    Object.assign(this, { status, code, fields, details, retryable });
  }
}

const RESPONSE_MODES = ['calls', 'offers', 'both'];
const CHANNELS = ['site', 'chatgpt', 'api', 'manager', 'other'];
const KINDS = ['service', 'goods', 'mixed'];
const COLLECTION_HOURS = { default: 24, min: 1, max: 168 };
// Сбор заканчивается не позже чем за 2 часа до начала работ; подтверждение выбора — не позже чем за час.
const START_MARGIN_HOURS = { collection: 2, confirmation: 1 };
const CONFIRM_HOURS = 24;
const OFFER_VALID_DEFAULT_HOURS = 72;
const LIMITS = { title: 120, description: 4000, address: 300, items: 30, itemName: 200, message: 2000, note: 2000, list: 10, listItem: 300, reason: 500 };
const HOUR = 60 * 60 * 1000;

// Деньги — целые тетри. Вход сайта — лари строкой («200», «200,50»), API — уже тетри (*_minor).
function gelToMinor(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().replace(',', '.').replace(/\s+/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return NaN;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

function minorToGel(minor) {
  if (minor === null || minor === undefined) return null;
  return (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);
}

function isMinor(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
}

// Время на страницах — по Тбилиси (часы без перевода на летнее время: Грузия всегда UTC+4).
const LOCALES = { ru: 'ru-RU', ka: 'ka-GE', en: 'en-GB' };
function formatLocal(date, lang = 'ru', timeZone = 'Asia/Tbilisi') {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat(LOCALES[lang] || 'ru-RU', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
  } catch { return new Date(date).toISOString(); }
}

function iso(date) {
  return date ? new Date(date).toISOString() : null;
}

module.exports = {
  DealError, RESPONSE_MODES, CHANNELS, KINDS, COLLECTION_HOURS, START_MARGIN_HOURS, CONFIRM_HOURS, OFFER_VALID_DEFAULT_HOURS, LIMITS, HOUR,
  gelToMinor, minorToGel, isMinor, formatLocal, iso,
};
