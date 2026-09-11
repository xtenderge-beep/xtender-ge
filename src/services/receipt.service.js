const pool = require('../config/db');

async function create(masterId, filename, topupId = null) {
  return pool.withTransaction(async client => {
    if (topupId !== null) {
      if (!Number.isSafeInteger(topupId) || topupId < 1) throw new Error('Invalid top-up');
      const topup = (await client.query('SELECT * FROM topup_requests WHERE id = $1 AND master_id = $2 FOR UPDATE', [topupId, masterId])).rows[0];
      if (!topup || !['awaiting','rejected'].includes(topup.status)) throw new Error('Receipt already received or top-up unavailable');
      await client.query("UPDATE topup_requests SET status = 'received', note = NULL, updated_at = NOW() WHERE id = $1", [topupId]);
    }
    const { rows } = await client.query('INSERT INTO topup_receipts (master_id, filename, topup_id) VALUES ($1, $2, $3) RETURNING *', [masterId, filename, topupId]);
    return rows[0];
  });
}
async function listForMaster(masterId) {
  return (await pool.query('SELECT id, status, credited_tetri, note, created_at, topup_id FROM topup_receipts WHERE master_id = $1 ORDER BY created_at DESC LIMIT 30', [masterId])).rows;
}
async function list() {
  return (await pool.query(`SELECT r.*, m.name, m.phone, p.reference, p.amount_tetri AS requested_tetri FROM topup_receipts r JOIN masters m ON m.id = r.master_id LEFT JOIN topup_requests p ON p.id = r.topup_id ORDER BY CASE WHEN r.status IN ('received','reviewing') THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`)).rows;
}
// A receipt documents a transfer already checked by a moderator. Linking an existing
// credit avoids charging/crediting twice when Telegram /topup was used first.
async function review(id, status, transactionId, note) {
  if (!['reviewing', 'credited', 'rejected'].includes(status)) throw new Error('Некорректный статус');
  return pool.withTransaction(async client => {
    const receipt = (await client.query('SELECT * FROM topup_receipts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!receipt || receipt.status === 'credited') throw new Error('Чек не найден или уже подтверждён');
    let topup = null;
    if (receipt.topup_id) {
      topup = (await client.query('SELECT * FROM topup_requests WHERE id = $1 FOR UPDATE', [receipt.topup_id])).rows[0];
      const latest = (await client.query('SELECT id FROM topup_receipts WHERE topup_id = $1 ORDER BY id DESC LIMIT 1', [receipt.topup_id])).rows[0];
      if (!topup || topup.status === 'credited' || latest.id !== receipt.id) throw new Error('Пополнение уже подтверждено или поступил новый чек');
    }
    let amount = null;
    if (status === 'credited') {
      if (!Number.isSafeInteger(transactionId) || transactionId <= 0) throw new Error('Укажите номер операции зачисления из истории баланса');
      const tx = (await client.query(`SELECT * FROM balance_transactions WHERE id = $1 AND master_id = $2 AND amount_tetri > 0 AND reason IN ('topup', 'admin_correction')`, [transactionId, receipt.master_id])).rows[0];
      if (!tx) throw new Error('Положительное зачисление этому исполнителю не найдено');
      amount = tx.amount_tetri;
      if (topup && amount !== topup.amount_tetri && !String(note || '').trim()) throw new Error('Сумма отличается от документа. Укажите объяснение для исполнителя');
    }
    try {
      await client.query(`UPDATE topup_receipts SET status = $2, balance_transaction_id = $3, credited_tetri = $4, note = $5, reviewed_at = NOW() WHERE id = $1`, [id, status, status === 'credited' ? transactionId : null, amount, note]);
      if (topup) await client.query('UPDATE topup_requests SET status = $2, balance_transaction_id = $3, credited_tetri = $4, note = $5, updated_at = NOW() WHERE id = $1', [topup.id, status, status === 'credited' ? transactionId : null, amount, note]);
    } catch (err) {
      if (err.code === '23505') throw new Error('Эта операция уже связана с другим чеком');
      throw err;
    }
  });
}
module.exports = { create, listForMaster, list, review };
