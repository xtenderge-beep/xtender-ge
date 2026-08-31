const pool = require('../config/db');

// Система не хранит, какой мастер "выиграл" заказ — прокси: те, кому клиент реально
// позвонил или написал в WhatsApp (просто "view" не считается контактом).
async function getEligibleMasters(orderId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (m.id) m.id, m.name, m.category, m.avatar_url,
            r.id AS review_id, r.rating AS existing_rating
     FROM order_views ov
     JOIN masters m ON m.id = ov.master_id
     LEFT JOIN master_reviews r ON r.master_id = m.id AND r.order_id = ov.order_id
     WHERE ov.order_id = $1 AND ov.event_type IN ('call', 'whatsapp')
     ORDER BY m.id`,
    [orderId]
  );
  return rows;
}

async function isMasterEligible(orderId, masterId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM order_views WHERE order_id = $1 AND master_id = $2 AND event_type IN ('call', 'whatsapp') LIMIT 1`,
    [orderId, masterId]
  );
  return rows.length > 0;
}

// try/catch на код уникального нарушения вместо ON CONFLICT DO NOTHING RETURNING * —
// как recordDispatch в order.service.js: pg-mem (локальная разработка) в таком случае
// возвращает существующую строку вместо пустого результата (см. HANDOFF.md).
async function submitReview({ orderId, masterId, rating, comment }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO master_reviews (master_id, order_id, rating, comment) VALUES ($1, $2, $3, $4) RETURNING *`,
      [masterId, orderId, rating, comment || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') return null; // отзыв на эту пару заказ+мастер уже существует
    throw err;
  }
}

// Все одобренные отзывы для набора мастеров — для инлайн-показа в каталоге на главной.
async function listApprovedForMasters(masterIds) {
  if (!masterIds.length) return [];
  const placeholders = masterIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT master_id, rating, comment, created_at
     FROM master_reviews
     WHERE is_approved = true AND master_id IN (${placeholders})
     ORDER BY created_at DESC`,
    masterIds
  );
  return rows;
}

// Флоу «оставить отзыв из каталога»: клиент подтвердил телефон по SMS — ищем его
// последнюю заявку, по которой он реально обращался к этому мастеру (call/whatsapp)
// и ещё не оставлял отзыв. phoneVariants — см. config/phone.js.
async function findReviewableOrder(phoneVariants, masterId) {
  if (!phoneVariants.length) return null;
  const placeholders = phoneVariants.map((_, i) => `$${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `SELECT o.id, o.description
     FROM order_views ov
     JOIN orders o ON o.id = ov.order_id
     LEFT JOIN master_reviews r ON r.order_id = o.id AND r.master_id = $1
     WHERE ov.master_id = $1
       AND ov.event_type IN ('call', 'whatsapp')
       AND o.phone IN (${placeholders})
       AND r.id IS NULL
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [masterId, ...phoneVariants]
  );
  return rows[0] || null;
}

// Отличить «нет подходящей заявки» от «отзыв уже оставлен» — для понятного текста ошибки.
async function hasReviewFromPhone(phoneVariants, masterId) {
  if (!phoneVariants.length) return false;
  const placeholders = phoneVariants.map((_, i) => `$${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `SELECT 1
     FROM master_reviews r
     JOIN orders o ON o.id = r.order_id
     WHERE r.master_id = $1 AND o.phone IN (${placeholders})
     LIMIT 1`,
    [masterId, ...phoneVariants]
  );
  return rows.length > 0;
}

async function listPending() {
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, m.id AS master_id, m.name AS master_name,
            o.token AS order_token, o.description AS order_description
     FROM master_reviews r
     JOIN masters m ON m.id = r.master_id
     JOIN orders o ON o.id = r.order_id
     WHERE r.is_approved = false
     ORDER BY r.created_at`
  );
  return rows;
}

async function approve(id) {
  await pool.query('UPDATE master_reviews SET is_approved = true WHERE id = $1', [id]);
}

async function reject(id) {
  // Публичного статуса "отклонён" не показываем нигде — для v1 просто удаляем.
  await pool.query('DELETE FROM master_reviews WHERE id = $1', [id]);
}

module.exports = {
  getEligibleMasters,
  isMasterEligible,
  submitReview,
  listApprovedForMasters,
  findReviewableOrder,
  hasReviewFromPhone,
  listPending,
  approve,
  reject,
};
