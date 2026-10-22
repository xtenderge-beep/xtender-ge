// Аккаунт API v1 (таблица accounts): номер телефона, подтверждённый кодом из SMS на странице входа OAuth.
// Роль заказчика есть у каждого аккаунта. Роль исполнителя — профиль в masters с тем же номером: его по-прежнему
// создаёт только регистрация на /join (две галочки, код из SMS, модератор), API её не выдаёт. Описание —
// docs/api-v1/BACKEND_AUDIT.md, раздел «Аккаунт и роли».
const { randomBytes } = require('node:crypto');
const pool = require('../config/db');
const { phoneVariants } = require('../config/phone');
const { normalizeLang } = require('../config/i18n');

const newId = () => 'usr_' + randomBytes(10).toString('hex');

async function getById(id, client = pool) {
  if (typeof id !== 'string' || !/^usr_[a-f0-9]{20}$/.test(id)) return null;
  return (await client.query('SELECT * FROM accounts WHERE id=$1', [id])).rows[0] || null;
}

// Вызывается только после проверки кода из SMS. Новый номер получает аккаунт, у прежнего обновляется время
// подтверждения (версия при этом не растёт: настройки аккаунта не менялись).
async function ensureForVerifiedPhone(phone, { locale } = {}) {
  await pool.query(
    `INSERT INTO accounts (id, phone, locale, phone_verified_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (phone) DO NOTHING`,
    [newId(), phone, normalizeLang(locale)]
  );
  await pool.query('UPDATE accounts SET phone_verified_at = NOW() WHERE phone = $1', [phone]);
  return (await pool.query('SELECT * FROM accounts WHERE phone=$1', [phone])).rows[0];
}

// Профиль исполнителя с тем же номером. Номера исполнителей хранятся в E.164, но старые записи сверяем по всем
// вариантам написания, как это делает журнал согласий.
async function providerFor(account, client = pool) {
  const variants = phoneVariants(account.phone);
  if (!variants.length) return null;
  const placeholders = variants.map((_, i) => `$${i + 1}`).join(', ');
  const rows = (await client.query(
    `SELECT id, is_active, is_banned, is_technical FROM masters WHERE phone IN (${placeholders}) ORDER BY id`, variants)).rows;
  return rows[0] || null;
}

function providerStatus(master) {
  if (!master) return null;
  return master.is_banned ? 'banned' : master.is_active ? 'active' : 'pending';
}

// Роли считаются на сервере из данных, а не из запроса: «provider» — профиль на модерации или одобренный;
// заблокированный исполнитель остаётся заказчиком.
async function roles(account, client = pool) {
  const master = await providerFor(account, client);
  const status = providerStatus(master);
  return { roles: status && status !== 'banned' ? ['customer', 'provider'] : ['customer'], master, providerStatus: status };
}

function maskedPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  const local = digits.slice(-9);
  return `+995 ${local.slice(0, 1)}•• •• •• ${local.slice(-2)}`;
}

// changes — только допустимые поля (проверяет контроллер). Правка проходит, если версия не изменилась.
async function update(id, version, changes) {
  const columns = Object.keys(changes);
  const sets = columns.map((column, i) => `${column} = $${i + 3}`);
  const { rows } = await pool.query(
    `UPDATE accounts SET ${[...sets, 'version = version + 1', 'updated_at = NOW()'].join(', ')}
     WHERE id = $1 AND version = $2 RETURNING *`,
    [id, version, ...columns.map((column) => changes[column])]
  );
  return rows[0] || null;
}

module.exports = { getById, ensureForVerifiedPhone, providerFor, providerStatus, roles, maskedPhone, update };
