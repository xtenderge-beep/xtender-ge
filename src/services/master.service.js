const pool = require('../config/db');
const { generateShortId } = require('../config/shortId');

const FIELDS = 'id, name, phone, category, vehicle_type, vehicle_size, price_text, description, avatar_url, rating';

async function registerMaster({ name, phone, category, vehicleType, vehicleSize, priceText, description }) {
  const masterToken = generateShortId();
  const { rows } = await pool.query(
    `INSERT INTO masters (name, phone, category, vehicle_type, vehicle_size, price_text, description, is_active, balance_tetri, master_token, terms_accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 0, $8, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       vehicle_type = EXCLUDED.vehicle_type,
       vehicle_size = EXCLUDED.vehicle_size,
       price_text = EXCLUDED.price_text,
       description = EXCLUDED.description,
       is_active = false,
       master_token = COALESCE(masters.master_token, EXCLUDED.master_token),
       terms_accepted_at = NOW()
     RETURNING *`,
    [name, phone, category, vehicleType || null, vehicleSize || null, priceText || null, description || null, masterToken]
  );
  return rows[0];
}

async function getMasterByToken(token) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason, created_at, master_token
     FROM masters WHERE master_token = $1`,
    [token]
  );
  return rows[0] || null;
}

// Лёгкий getter по id — для плашки «баланс / мой аккаунт» на странице лида.
async function getMasterById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, master_token, balance_tetri, is_active, is_banned FROM masters WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Активность мастера для его личного кабинета: среднее время реакции + сколько
// уведомлений отвечено + лидов за 30 дней. Время реакции считается так же, как в
// adminService.getResponseStats (balance_transactions reason='lead_charge' —
// единственное место, где хранится связка «мастер X уведомлён о заявке Y в момент T»);
// при правке одного — синхронизировать второй. Без коррелированных подзапросов и
// date_trunc/INTERVAL — pg-mem (локальная разработка) их не тянет.
async function getMasterActivity(masterId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [respRes, recentRes] = await Promise.all([
    pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM responded_at) - EXTRACT(EPOCH FROM notified_at)) AS avg_seconds,
              COUNT(responded_at)::int AS responded_count,
              COUNT(*)::int AS total_count
       FROM (
         SELECT bt.order_id, bt.created_at AS notified_at, MIN(ov.viewed_at) AS responded_at
         FROM balance_transactions bt
         LEFT JOIN order_views ov
           ON ov.order_id = bt.order_id AND ov.master_id = bt.master_id AND ov.event_type IN ('view', 'call')
         WHERE bt.reason = 'lead_charge' AND bt.master_id = $1
         GROUP BY bt.order_id, bt.created_at
       ) sub`,
      [masterId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM balance_transactions
       WHERE master_id = $1 AND reason = 'lead_charge' AND created_at >= $2`,
      [masterId, since]
    ),
  ]);
  const r = respRes.rows[0];
  return {
    avgSeconds: r.avg_seconds === null ? null : Number(r.avg_seconds),
    respondedCount: r.responded_count,
    totalCount: r.total_count,
    leads30d: recentRes.rows[0].count,
  };
}

async function getMasterBalanceHistory(masterId, limit = 40) {
  const { rows } = await pool.query(
    `SELECT amount_tetri, reason, note, created_at
     FROM balance_transactions
     WHERE master_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [masterId, limit]
  );
  return rows;
}

// Все лиды, за которые с мастера реально списали деньги — balance_transactions
// (reason='lead_charge') это единственное место, где хранится связка «мастеру ушла
// заявка Y в момент T» (то же, что используют getMasterActivity / adminService.getResponseStats).
// Плюс отметка, связался ли он уже с клиентом (order_views call/whatsapp) — считаем
// в производной таблице, а не коррелированным подзапросом (pg-mem их не тянет, см. HANDOFF).
// Дедуп по order_id в JS: мастер с vehicle_size IS NULL может попасть под две рассылки
// одной заявки (все размеры + конкретный тир) и получить две строки lead_charge.
async function getMasterLeads(masterId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT o.id, o.token, o.description, o.status, o.created_at, o.closed_at,
            bt.created_at AS notified_at,
            COALESCE(ev.call_count, 0) AS call_count,
            COALESCE(ev.whatsapp_count, 0) AS whatsapp_count,
            COALESCE(ev.view_count, 0) AS view_count
     FROM balance_transactions bt
     JOIN orders o ON o.id = bt.order_id
     LEFT JOIN (
       SELECT order_id,
              SUM(CASE WHEN event_type = 'call' THEN 1 ELSE 0 END)::int AS call_count,
              SUM(CASE WHEN event_type = 'whatsapp' THEN 1 ELSE 0 END)::int AS whatsapp_count,
              SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END)::int AS view_count
       FROM order_views
       WHERE master_id = $1
       GROUP BY order_id
     ) ev ON ev.order_id = o.id
     WHERE bt.reason = 'lead_charge' AND bt.master_id = $1
     ORDER BY bt.created_at DESC
     LIMIT $2`,
    [masterId, limit]
  );

  const seen = new Set();
  return rows.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)));
}

async function approveMaster(id) {
  const { rows } = await pool.query(
    `UPDATE masters SET is_active = true WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function getMasterByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason, master_token FROM masters WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

// Единственная точка изменения баланса — каждое изменение пишет строку в
// balance_transactions в той же транзакции, чтобы история никогда не разошлась
// с реальным balance_tetri. Передавайте client из pool.withTransaction(...),
// когда вызов идёт не изолированно (см. chargeMastersForLead, topUpBalance).
async function adjustBalance({ masterId, phone, amountTetri, reason, orderId = null, note = null }, client = pool) {
  if (!masterId && !phone) throw new Error('adjustBalance requires masterId or phone');
  const idColumn = masterId ? 'id' : 'phone'; // литерал, не пользовательский ввод
  const { rows } = await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE ${idColumn} = $2 RETURNING *`,
    [amountTetri, masterId || phone]
  );
  const master = rows[0];
  if (!master) return null;
  await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id, note) VALUES ($1, $2, $3, $4, $5)`,
    [master.id, amountTetri, reason, orderId, note]
  );
  return master;
}

// Списание за лид сразу по всем уведомлённым мастерам одним UPDATE + один multi-row
// INSERT в журнал (заодно фиксирует, кому реально ушло уведомление по заявке — эта
// связь раньше нигде не хранилась). Плейсхолдеры строятся вручную, как в
// getOrdersByTokens/attachFiles в order.service.js — не через ANY($::int[])/UNNEST:
// оба варианта не работают под pg-mem (используется для локальной разработки,
// dev-server.js), а IN (...) с явными плейсхолдерами работает одинаково и там, и на
// реальном Postgres.
async function chargeMastersForLead(masterIds, amountTetri, orderId, client = pool) {
  if (!masterIds.length) return;

  const idPlaceholders = masterIds.map((_, i) => `$${i + 2}`).join(', ');
  await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE id IN (${idPlaceholders})`,
    [-amountTetri, ...masterIds]
  );

  const values = [];
  const rowPlaceholders = masterIds
    .map((masterId, i) => {
      const base = i * 3;
      values.push(masterId, -amountTetri, orderId);
      return `($${base + 1}, $${base + 2}, 'lead_charge', $${base + 3})`;
    })
    .join(', ');
  await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id) VALUES ${rowPlaceholders}`,
    values
  );
}

async function topUpBalance(phone, amountTetri) {
  return pool.withTransaction((client) => adjustBalance({ phone, amountTetri, reason: 'topup' }, client));
}

// Редактирование профиля из админки — единственное место, где допускается менять
// category/vehicle_size вручную (при саморегистрации на /join vehicle_size сознательно
// остаётся NULL — «любой размер», см. HANDOFF.md; тут модератор может сузить конкретного
// мастера до одного тира).
async function updateMasterProfile(id, { name, phone, category, vehicleType, vehicleSize, isFlatbed, priceText, description }) {
  const { rows } = await pool.query(
    `UPDATE masters SET name = $1, phone = $2, category = $3, vehicle_type = $4, vehicle_size = $5,
            is_flatbed = $6, price_text = $7, description = $8
     WHERE id = $9 RETURNING *`,
    [name, phone, category, vehicleType || null, vehicleSize || null, isFlatbed, priceText || null, description || null, id]
  );
  return rows[0] || null;
}

const LIST_FIELDS = 'm.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url';

async function listMasters({ category } = {}) {
  const params = [];
  let where = 'm.is_active = true AND m.is_banned = false';
  if (category) {
    params.push(category);
    where += ` AND m.category = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${LIST_FIELDS}, COALESCE(AVG(r.rating)::numeric(3,2), 0) AS rating, COUNT(r.id)::int AS review_count
     FROM masters m
     LEFT JOIN master_reviews r ON r.master_id = m.id AND r.is_approved = true
     WHERE ${where}
     GROUP BY m.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url
     ORDER BY m.id`,
    params
  );
  return rows;
}

module.exports = {
  registerMaster,
  getMasterByToken,
  getMasterById,
  getMasterByPhone,
  getMasterActivity,
  getMasterBalanceHistory,
  getMasterLeads,
  approveMaster,
  updateMasterProfile,
  adjustBalance,
  chargeMastersForLead,
  topUpBalance,
  listMasters,
};
