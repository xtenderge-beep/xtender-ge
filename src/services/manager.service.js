const pool = require('../config/db');
const { toE164 } = require('../config/phone');

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
};
