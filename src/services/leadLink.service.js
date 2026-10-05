const { randomBytes, createHash } = require('node:crypto');
const pool = require('../config/db');

// Личная ссылка исполнителя на заявку: /order/<ссылка заявки>?k=<ключ>. Ключ из SMS или Telegram
// позволяет открыть заявку и получить контакт заказчика без входа в кабинет — но только в первом
// браузере, где ссылкой воспользовались. В любом другом браузере она ведёт себя как обычная ссылка
// на заявку: текст виден, контакт — после входа по коду из SMS. Кабинет и баланс ключ не открывает,
// а контакт по-прежнему выдаётся только тому, с кого за эту заявку списано (orderContact.service).
// В таблице ссылок лежат только хеши ключа и устройства. Сам текст отправленного SMS со ссылкой
// хранится в журнале доказательств списания (LEAD_CHARGE_ACCEPTED, message_body) — как и раньше.
const DEVICE_COOKIE = 'lead_device';
const DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{22}$/, DEVICE = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const valid = key => typeof key === 'string' && KEY.test(key);
const deviceOf = req => DEVICE.test(req.cookies?.[DEVICE_COOKIE] || '') ? req.cookies[DEVICE_COOKIE] : null;

// Новый ключ для пары «заявка — исполнитель». Повторная отправка тому же исполнителю заменяет
// прежний ключ и снимает привязку: старая ссылка перестаёт работать.
async function issue(orderId, masterId, client = pool) {
  const key = randomBytes(16).toString('base64url');
  await client.query(`INSERT INTO lead_links(order_id, master_id, key_hash) VALUES($1,$2,$3)
    ON CONFLICT (order_id, master_id) DO UPDATE SET key_hash=EXCLUDED.key_hash, device_hash=NULL, bound_at=NULL, created_at=NOW()`,
    [orderId, masterId, hash(key)]);
  return key;
}

// Чья это ссылка и можно ли пользоваться ею в этом браузере. Ничего не меняет: открытие страницы,
// в том числе роботом предпросмотра в мессенджере, ссылку не привязывает.
//   free — ею ещё не пользовались; mine — привязана к этому браузеру; taken — к другому.
async function look(req, order, key) {
  if (!order || !valid(key)) return null;
  const row = (await pool.query('SELECT master_id, device_hash FROM lead_links WHERE order_id=$1 AND key_hash=$2', [order.id, hash(key)])).rows[0];
  if (!row) return null;
  const device = deviceOf(req);
  return { masterId: row.master_id, state: !row.device_hash ? 'free' : device && row.device_hash === hash(device) ? 'mine' : 'taken' };
}

// Действие со страницы заявки (просмотр, «Позвонить», WhatsApp): свободная ссылка привязывается к
// этому браузеру. Возвращает id исполнителя, если этот браузер вправе действовать по ссылке.
async function claim(req, res, order, key) {
  if (!order || !valid(key)) return null;
  return pool.withTransaction(async client => {
    const row = (await client.query('SELECT id, master_id, device_hash FROM lead_links WHERE order_id=$1 AND key_hash=$2 FOR UPDATE', [order.id, hash(key)])).rows[0];
    if (!row) return null;
    let device = deviceOf(req);
    if (row.device_hash) return device && row.device_hash === hash(device) ? row.master_id : null;
    if (!device) {
      device = randomBytes(32).toString('hex');
      res.cookie(DEVICE_COOKIE, device, { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), path: '/', maxAge: DEVICE_TTL_MS });
    }
    await client.query('UPDATE lead_links SET device_hash=$1, bound_at=NOW() WHERE id=$2', [hash(device), row.id]);
    return row.master_id;
  });
}

module.exports = { DEVICE_COOKIE, issue, look, claim };
