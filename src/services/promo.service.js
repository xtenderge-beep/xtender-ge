const pool = require('../config/db');
const masterService = require('./master.service');

// Промокод при регистрации. Корректность не зависит от отката транзакции (pg-mem его
// не делает, см. HANDOFF): каждый шаг атомарен, при провале гашения кода явно
// освобождаем пометку мастера.

// Создание кода модератором (бот, команда /promo). amountGel в лари, maxRedemptions
// необязателен (NULL = без лимита).
async function createCode({ code, amountTetri, maxRedemptions = null, expiresAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO promo_codes (code, amount_tetri, max_redemptions, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET
       amount_tetri = EXCLUDED.amount_tetri,
       max_redemptions = EXCLUDED.max_redemptions,
       expires_at = EXCLUDED.expires_at,
       is_active = true
     RETURNING *`,
    [code, amountTetri, maxRedemptions, expiresAt]
  );
  return rows[0];
}

async function listCodes() {
  const { rows } = await pool.query(
    `SELECT id, code, amount_tetri, max_redemptions, redeemed_count, expires_at, is_active, created_at
     FROM promo_codes ORDER BY created_at DESC`
  );
  return rows;
}

async function setActive(id, isActive) {
  await pool.query(`UPDATE promo_codes SET is_active = $1 WHERE id = $2`, [isActive, id]);
}

// Проверка без списания — для показа на форме / ранней валидации.
async function peek(code) {
  const { rows } = await pool.query(
    `SELECT code, amount_tetri, max_redemptions, redeemed_count, expires_at
     FROM promo_codes
     WHERE code = $1 AND is_active = true
       AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [code]
  );
  return rows[0] || null;
}

// Применить код к мастеру. Возвращает начисленную сумму в тетри либо null
// (мастер уже гасил промокод / код невалиден или исчерпан).
async function apply(masterId, code) {
  // 1. занимаем мастера под этот код — атомарно, один промокод на мастера
  const mark = await pool.query(
    `UPDATE masters SET promo_code_used = $2 WHERE id = $1 AND promo_code_used IS NULL RETURNING id`,
    [masterId, code]
  );
  if (!mark.rows[0]) return null;

  // 2. гасим код — атомарно, с проверкой лимита и срока
  const redeem = await pool.query(
    `UPDATE promo_codes SET redeemed_count = redeemed_count + 1
     WHERE code = $1 AND is_active = true
       AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING amount_tetri`,
    [code]
  );
  if (!redeem.rows[0]) {
    // код не подошёл — освобождаем мастера обратно
    await pool.query(
      `UPDATE masters SET promo_code_used = NULL WHERE id = $1 AND promo_code_used = $2`,
      [masterId, code]
    );
    return null;
  }

  const amountTetri = redeem.rows[0].amount_tetri;
  await masterService.adjustBalance({ masterId, amountTetri, reason: 'promo', note: code });
  return amountTetri;
}

module.exports = { createCode, listCodes, setActive, peek, apply };
