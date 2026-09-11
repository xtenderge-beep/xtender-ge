const pool = require('../config/db');

async function create(masterId, filename) {
  const { rows } = await pool.query('INSERT INTO topup_receipts (master_id, filename) VALUES ($1, $2) RETURNING *', [masterId, filename]);
  return rows[0];
}
async function listForMaster(masterId) {
  return (await pool.query('SELECT id, status, credited_tetri, note, created_at FROM topup_receipts WHERE master_id = $1 ORDER BY created_at DESC LIMIT 30', [masterId])).rows;
}
async function list() {
  return (await pool.query(`SELECT r.*, m.name, m.phone FROM topup_receipts r JOIN masters m ON m.id = r.master_id ORDER BY CASE WHEN r.status IN ('received','reviewing') THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`)).rows;
}
// A receipt documents a transfer already checked by a moderator. Linking an existing
// credit avoids charging/crediting twice when Telegram /topup was used first.
async function review(id, status, transactionId, note) {
  if (!['reviewing', 'credited', 'rejected'].includes(status)) throw new Error('Некорректный статус');
  return pool.withTransaction(async client => {
    const receipt = (await client.query('SELECT * FROM topup_receipts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!receipt || receipt.status === 'credited') throw new Error('Чек не найден или уже подтверждён');
    let amount = null;
    if (status === 'credited') {
      if (!Number.isSafeInteger(transactionId) || transactionId <= 0) throw new Error('Укажите номер операции зачисления из истории баланса');
      const tx = (await client.query(`SELECT * FROM balance_transactions WHERE id = $1 AND master_id = $2 AND amount_tetri > 0 AND reason IN ('topup', 'admin_correction')`, [transactionId, receipt.master_id])).rows[0];
      if (!tx) throw new Error('Положительное зачисление этому исполнителю не найдено');
      amount = tx.amount_tetri;
    }
    try {
      await client.query(`UPDATE topup_receipts SET status = $2, balance_transaction_id = $3, credited_tetri = $4, note = $5, reviewed_at = NOW() WHERE id = $1`, [id, status, status === 'credited' ? transactionId : null, amount, note]);
    } catch (err) {
      if (err.code === '23505') throw new Error('Эта операция уже связана с другим чеком');
      throw err;
    }
  });
}
module.exports = { create, listForMaster, list, review };
