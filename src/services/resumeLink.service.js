// Ссылка возврата из SMS: https://xtender.ge/r/<токен> (ТЗ, раздел 9). В базе только хеш и срок. Страница по ссылке
// показывает номер и состояние заявки, команду для ChatGPT и повтор ссылки на страницу заявки по SMS — но не предложения,
// контакты и переписку: пересланная ссылка личных данных не открывает.
const crypto = require('node:crypto');
const pool = require('../config/db');
const { getBaseUrl } = require('../config/url');

const TTL_DAYS = 14;
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

async function create(orderId, client = pool) {
  const token = crypto.randomBytes(24).toString('base64url');
  await client.query('INSERT INTO resume_links (token_hash, order_id, expires_at) VALUES ($1,$2,$3)',
    [sha(token), orderId, new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)]);
  return { url: getBaseUrl() + '/r/' + token, expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000) };
}

async function resolve(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const row = (await pool.query('SELECT * FROM resume_links WHERE token_hash=$1', [sha(token)])).rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return { expired: true };
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [row.order_id])).rows[0];
  return order ? { order } : null;
}

// Готовая команда для ChatGPT: номер заявки и что сделать. Не обещаем, что откроется прежний разговор.
function chatPrompt(order, lang = 'ru') {
  const texts = {
    ru: `@Xtender Проверь мою заявку №${order.id} на xtender.ge: получи актуальные предложения и сравни полную стоимость, сроки и соответствие требованиям.`,
    ka: `@Xtender შეამოწმე ჩემი განაცხადი №${order.id} xtender.ge-ზე: მიიღე მიმდინარე შეთავაზებები და შეადარე სრული ღირებულება, ვადები და მოთხოვნებთან შესაბამისობა.`,
    en: `@Xtender Check my request #${order.id} on xtender.ge: get the current offers and compare the full price, timing and fit to the requirements.`,
  };
  return texts[lang] || texts.en;
}

module.exports = { create, resolve, chatPrompt, TTL_DAYS };
