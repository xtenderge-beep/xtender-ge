const pool = require('../config/db');
const masterService = require('./master.service');

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
// Invoice-centric view for admin: every top-up request the master created, whether or
// not a receipt was ever attached, so staff can confirm bank transfers proactively
// instead of waiting for an upload. Two queries + a JS merge (not a JOIN) because a
// topup can have several receipts (rejected, then re-uploaded) and this stays simple
// under pg-mem, which the dev/test harness relies on.
async function list() {
  const { rows: topups } = await pool.query(`SELECT t.*, m.name, m.phone FROM topup_requests t JOIN masters m ON m.id = t.master_id ORDER BY CASE WHEN t.status = 'credited' THEN 1 ELSE 0 END, t.created_at DESC LIMIT 100`);
  if (!topups.length) return topups;
  const ids = topups.map(t => t.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: receipts } = await pool.query(`SELECT * FROM topup_receipts WHERE topup_id IN (${placeholders}) ORDER BY id ASC`, ids);
  const latestByTopup = new Map();
  for (const r of receipts) latestByTopup.set(r.topup_id, r); // ascending id order: last write wins = highest id
  return topups.map(t => ({ ...t, receipt: latestByTopup.get(t.id) || null }));
}
// Reviewing a receipt only flags it as being checked or asks for a clearer one — it
// never moves money. Crediting always goes through confirmPayment below, which is the
// only place that touches balance_transactions for a top-up.
async function review(id, status, note) {
  if (!['reviewing', 'rejected'].includes(status)) throw new Error('Некорректный статус');
  return pool.withTransaction(async client => {
    const receipt = (await client.query('SELECT * FROM topup_receipts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!receipt || receipt.status === 'credited') throw new Error('Чек не найден или уже подтверждён');
    if (receipt.topup_id) {
      const latest = (await client.query('SELECT id FROM topup_receipts WHERE topup_id = $1 ORDER BY id DESC LIMIT 1', [receipt.topup_id])).rows[0];
      if (latest.id !== receipt.id) throw new Error('Загружен более новый чек по этому пополнению');
    }
    await client.query('UPDATE topup_receipts SET status = $2, note = $3, reviewed_at = NOW() WHERE id = $1', [id, status, note]);
    if (status === 'rejected' && receipt.topup_id) {
      await client.query("UPDATE topup_requests SET status = 'rejected', note = $2, updated_at = NOW() WHERE id = $1 AND status != 'credited'", [receipt.topup_id, note]);
    }
  });
}
// The one place a top-up actually credits a master: goes through
// masterService.adjustBalance (the single point of balance mutation) so the ledger
// never disagrees with masters.balance_tetri, then marks the invoice — and its latest
// receipt, if any was attached — as credited.
async function confirmPayment(topupId, amountTetri, note) {
  if (!Number.isSafeInteger(topupId) || topupId < 1) throw new Error('Invalid top-up');
  if (!Number.isSafeInteger(amountTetri) || amountTetri <= 0) throw new Error('Укажите сумму зачисления');
  note = String(note || '').trim().slice(0, 500) || null;
  return pool.withTransaction(async client => {
    const topup = (await client.query('SELECT * FROM topup_requests WHERE id = $1 FOR UPDATE', [topupId])).rows[0];
    if (!topup) throw new Error('Пополнение не найдено');
    if (topup.status === 'credited') throw new Error('Пополнение уже подтверждено');
    if (amountTetri !== topup.amount_tetri && !note) throw new Error('Сумма отличается от документа. Укажите объяснение для исполнителя');
    const master = await masterService.adjustBalance({ masterId: topup.master_id, amountTetri, reason: 'topup', note }, client);
    if (!master) throw new Error('Исполнитель не найден');
    // adjustBalance just inserted this row on the same client, and the UPDATE masters
    // it ran above holds a row lock on this master_id until we commit — no other
    // transaction can insert another balance_transactions row for them meanwhile.
    const ledger = (await client.query('SELECT id FROM balance_transactions WHERE master_id = $1 ORDER BY id DESC LIMIT 1', [topup.master_id])).rows[0];
    await client.query('UPDATE topup_requests SET status = $2, balance_transaction_id = $3, credited_tetri = $4, note = $5, updated_at = NOW() WHERE id = $1', [topupId, 'credited', ledger.id, amountTetri, note]);
    const latestReceipt = (await client.query('SELECT id FROM topup_receipts WHERE topup_id = $1 ORDER BY id DESC LIMIT 1', [topupId])).rows[0];
    if (latestReceipt) await client.query('UPDATE topup_receipts SET status = $2, balance_transaction_id = $3, credited_tetri = $4, note = $5, reviewed_at = NOW() WHERE id = $1', [latestReceipt.id, 'credited', ledger.id, amountTetri, note]);
  });
}
module.exports = { create, listForMaster, list, review, confirmPayment };
