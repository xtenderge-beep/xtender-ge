const pool = require('../config/db');
const { toE164 } = require('../config/phone');
const { generateShortId } = require('../config/shortId');

const FIELDS = 'id, name, phone, telegram_id, telegram_linked_at, is_moderator, is_active, created_at';

async function create({ name, phone, isModerator = false }) {
  const { rows } = await pool.query(
    `INSERT INTO managers (name, phone, is_moderator)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, is_moderator = EXCLUDED.is_moderator, is_active = true
     RETURNING ${FIELDS}`,
    [name, toE164(phone), Boolean(isModerator)]
  );
  return rows[0];
}

// Список с числом приведённых исполнителей — без коррелированных подзапросов (pg-mem).
async function list() {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.phone, m.telegram_id, m.is_moderator, m.is_active, m.created_at,
            COALESCE(pc.cnt, 0) AS provider_count
     FROM managers m
     LEFT JOIN (
       SELECT manager_id, COUNT(*)::int AS cnt FROM masters WHERE manager_id IS NOT NULL GROUP BY manager_id
     ) pc ON pc.manager_id = m.id
     ORDER BY m.created_at DESC`
  );
  return rows;
}

async function getById(id) {
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM managers WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getByPhone(phone) {
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM managers WHERE phone = $1`, [toE164(phone)]);
  return rows[0] || null;
}

async function getByTelegramId(telegramId) {
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM managers WHERE telegram_id = $1`, [telegramId]);
  return rows[0] || null;
}

async function linkTelegram(managerId, telegramId) {
  // снимаем этот telegram_id с любого другого менеджера (один чат — один менеджер)
  await pool.query(`UPDATE managers SET telegram_id = NULL WHERE telegram_id = $1 AND id <> $2`, [telegramId, managerId]);
  const { rows } = await pool.query(
    `UPDATE managers SET telegram_id = $1, telegram_linked_at = NOW() WHERE id = $2 RETURNING ${FIELDS}`,
    [telegramId, managerId]
  );
  return rows[0] || null;
}

async function update(id, { isModerator, isActive }) {
  const { rows } = await pool.query(
    `UPDATE managers SET is_moderator = $1, is_active = $2 WHERE id = $3 RETURNING ${FIELDS}`,
    [Boolean(isModerator), Boolean(isActive), id]
  );
  return rows[0] || null;
}

// Активные модераторы с привязанным Telegram — кому рассылать заявки на модерацию.
async function listActiveModeratorChatIds() {
  const { rows } = await pool.query(
    `SELECT telegram_id FROM managers WHERE is_moderator = true AND is_active = true AND telegram_id IS NOT NULL`
  );
  return rows.map((r) => r.telegram_id);
}

async function isActiveModerator(telegramId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM managers WHERE telegram_id = $1 AND is_moderator = true AND is_active = true LIMIT 1`,
    [telegramId]
  );
  return rows.length > 0;
}

async function getProviders(managerId) {
  const { rows } = await pool.query(
    `SELECT id, name, phone, balance_tetri, is_active, is_banned, promo_code_used, created_at
     FROM masters WHERE manager_id = $1 ORDER BY created_at DESC`,
    [managerId]
  );
  return rows;
}

// Сводка для /mystats и /admin/managers/:id.
async function getStats(managerId) {
  const [providers, bonus] = await Promise.all([
    getProviders(managerId),
    pool.query(
      `SELECT COALESCE(SUM(bt.amount_tetri), 0)::int AS total
       FROM balance_transactions bt
       JOIN promo_codes pc ON pc.code = bt.note
       WHERE bt.reason = 'promo' AND pc.manager_id = $1`,
      [managerId]
    ),
  ]);
  return {
    providers,
    total: providers.length,
    active: providers.filter((p) => p.is_active && !p.is_banned).length,
    bonusPaidTetri: bonus.rows[0].total,
  };
}

// Назначить/сменить менеджера исполнителю (из карточки в /admin).
async function assignProvider(masterId, managerId) {
  await pool.query(`UPDATE masters SET manager_id = $1 WHERE id = $2`, [managerId || null, masterId]);
}

// --- Персональные ссылки менеджера для заказчиков ---

async function createClientInvite(managerId, phone) {
  const token = generateShortId();
  await pool.query(
    `INSERT INTO client_invites (token, manager_id, phone) VALUES ($1, $2, $3)`,
    [token, managerId, toE164(phone)]
  );
  return token;
}

async function getClientInvite(token) {
  const { rows } = await pool.query(`SELECT * FROM client_invites WHERE token = $1`, [token]);
  return rows[0] || null;
}

async function markInviteOpened(token) {
  await pool.query(
    `UPDATE client_invites SET opened_at = COALESCE(opened_at, NOW()) WHERE token = $1`,
    [token]
  );
}

async function linkInviteToOrder(token, orderId) {
  await pool.query(
    `UPDATE client_invites SET order_id = $1 WHERE token = $2 AND order_id IS NULL`,
    [orderId, token]
  );
}

// Воронка по заявкам клиентов, пришедшим по ссылкам менеджера. Без коррелированных
// подзапросов (pg-mem): считаем в JS по двум плоским выборкам.
async function getClientFunnel(managerId) {
  const { rows: invites } = await pool.query(
    `SELECT token, order_id, opened_at FROM client_invites WHERE manager_id = $1`,
    [managerId]
  );
  const orderIds = invites.map((i) => i.order_id).filter(Boolean);
  let orders = [];
  if (orderIds.length) {
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `SELECT o.id, o.status, o.first_dispatched_at,
              COALESCE(ev.contacted, 0)::int AS contacted
       FROM orders o
       LEFT JOIN (
         SELECT order_id, COUNT(*) AS contacted FROM order_views
         WHERE event_type IN ('call', 'whatsapp') GROUP BY order_id
       ) ev ON ev.order_id = o.id
       WHERE o.id IN (${ph})`,
      orderIds
    );
    orders = rows;
  }
  return {
    linksSent: invites.length,
    linksOpened: invites.filter((i) => i.opened_at).length,
    ordersCreated: orderIds.length,
    ordersDispatched: orders.filter((o) => o.first_dispatched_at).length,
    ordersContacted: orders.filter((o) => o.contacted > 0).length,
    ordersClosed: orders.filter((o) => o.status === 'closed').length,
  };
}

module.exports = {
  create,
  list,
  getById,
  getByPhone,
  getByTelegramId,
  linkTelegram,
  update,
  listActiveModeratorChatIds,
  isActiveModerator,
  getProviders,
  getStats,
  assignProvider,
  createClientInvite,
  getClientInvite,
  markInviteOpened,
  linkInviteToOrder,
  getClientFunnel,
};
