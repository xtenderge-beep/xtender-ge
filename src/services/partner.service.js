const crypto = require('crypto');
const pool = require('../config/db');
class PartnerError extends Error {}

function decimalToInt(value, max = 100000000) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new PartnerError('Укажите число с точностью до двух знаков.');
  const [whole, fraction = ''] = text.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n > max) throw new PartnerError('Сумма или ставка вне допустимого диапазона.');
  return n;
}
function monthBounds(value) {
  const month = value || new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 7);
  if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new PartnerError('Некорректный месяц.');
  const start = new Date(month + '-01T00:00:00+04:00');
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1) - 4 * 3600000);
  return { month, start, end };
}
async function audit(client, managerId, action, detail) {
  await client.query('INSERT INTO partner_audit(manager_id, action, detail) VALUES($1,$2,$3::jsonb)', [managerId, action, JSON.stringify(detail)]);
}
async function getManager(id, client = pool, lock = false) {
  return (await client.query('SELECT id,name,phone,is_active,commission_bps,referral_token FROM managers WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0] || null;
}
async function createLink(id) {
  return pool.withTransaction(async client => {
    const manager = await getManager(id, client, true);
    if (!manager || !manager.is_active) throw new PartnerError('Активный менеджер не найден.');
    if (manager.referral_token) return manager.referral_token;
    const token = crypto.randomBytes(18).toString('hex');
    await client.query('UPDATE managers SET referral_token=$2 WHERE id=$1', [id, token]);
    await audit(client, id, 'link_created', {});
    return token;
  });
}
async function setRate(id, percent) {
  const bps = decimalToInt(percent, 10000);
  return pool.withTransaction(async client => {
    const manager = await getManager(id, client, true);
    if (!manager) throw new PartnerError('Менеджер не найден.');
    await client.query('UPDATE managers SET commission_bps=$2 WHERE id=$1', [id, bps]);
    await audit(client, id, 'rate_changed', { from_bps: manager.commission_bps, to_bps: bps });
  });
}
async function findReferrer(token, promoCode, client = pool) {
  if (typeof token === 'string' && /^[a-f0-9]{36}$/.test(token)) {
    const m = (await client.query('SELECT id FROM managers WHERE referral_token=$1 AND is_active=true', [token])).rows[0];
    if (m) return m.id;
  }
  if (typeof promoCode === 'string' && promoCode.trim()) {
    const m = (await client.query(`SELECT m.id FROM promo_codes p JOIN managers m ON m.id=p.manager_id
      WHERE p.code=$1 AND p.is_active=true AND m.is_active=true
      AND (p.max_redemptions IS NULL OR p.redeemed_count < p.max_redemptions)
      AND (p.expires_at IS NULL OR p.expires_at > NOW())`, [promoCode.trim().toUpperCase()])).rows[0];
    if (m) return m.id;
  }
  return null;
}
async function bindNew(master, isNew, token, promoCode, client) {
  if (!isNew) return;
  const managerId = await findReferrer(token, promoCode, client);
  if (!managerId) return;
  await client.query('UPDATE masters SET referral_manager_id=$2, referral_bound_at=NOW(), manager_id=COALESCE(manager_id,$2) WHERE id=$1 AND referral_manager_id IS NULL', [master.id, managerId]);
  await client.query("UPDATE crm_invites SET master_id=$3 WHERE manager_id=$1 AND phone=$2 AND kind='provider' AND master_id IS NULL",[managerId,require('../config/phone').toE164(master.phone),master.id]);
  await audit(client, managerId, 'referral_registered', { master_id: master.id });
}
async function bindExisting(managerId, masterId, note) {
  if (!Number.isSafeInteger(masterId) || masterId < 1 || typeof note !== 'string' || note.trim().length < 5 || note.length > 1000) throw new PartnerError('Укажите ID специалиста и основание привязки (5–1000 символов).');
  return pool.withTransaction(async client => {
    const manager = await getManager(managerId, client);
    if (!manager || !manager.is_active) throw new PartnerError('Активный менеджер не найден.');
    const row = (await client.query('UPDATE masters SET referral_manager_id=$2, referral_bound_at=NOW(), manager_id=COALESCE(manager_id,$2) WHERE id=$1 AND referral_manager_id IS NULL RETURNING id', [masterId, managerId])).rows[0];
    if (!row) throw new PartnerError('Специалист не найден или источник уже закреплён.');
    await audit(client, managerId, 'referral_bound_by_admin', { master_id: masterId, note: note.trim(), applies: 'future_topups_only' });
  });
}
async function accrue(transaction, master, client) {
  if (transaction.reason !== 'topup' || Number(transaction.amount_tetri) <= 0 || !master.referral_manager_id) return;
  // Lock the rate while recording its snapshot. Deactivating a manager prevents new links,
  // but does not silently cancel earned rights; set the rate to zero to stop future accruals.
  const manager = await getManager(master.referral_manager_id, client, true);
  if (!manager) throw new PartnerError('Referral manager missing');
  const bps = Number(manager.commission_bps);
  const amount = Number((BigInt(transaction.amount_tetri) * BigInt(bps) + 5000n) / 10000n);
  await client.query(`INSERT INTO manager_commissions(manager_id,master_id,transaction_id,base_tetri,rate_bps,amount_tetri)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (transaction_id) DO NOTHING`, [manager.id, master.id, transaction.id, transaction.amount_tetri, bps, amount]);
}
async function report(monthValue) {
  const range = monthBounds(monthValue);
  const [managers, commissions, payouts, providers] = await Promise.all([
    pool.query('SELECT id,name,is_active,commission_bps,referral_token FROM managers ORDER BY name'),
    pool.query(`SELECT c.*,m.name AS master_name FROM manager_commissions c LEFT JOIN masters m ON m.id=c.master_id WHERE c.created_at < $1 ORDER BY c.created_at DESC,c.id DESC`, [range.end]),
    pool.query('SELECT * FROM manager_payouts WHERE commission_month <= $1 ORDER BY paid_at DESC,id DESC', [range.month]),
    pool.query('SELECT id,name,phone,referral_manager_id,manager_id,referral_bound_at,balance_tetri FROM masters WHERE referral_manager_id IS NOT NULL ORDER BY id DESC'),
  ]);
  const rows = managers.rows.map(m => {
    const all = commissions.rows.filter(c => c.manager_id === m.id);
    const current = all.filter(c => new Date(c.created_at) >= range.start);
    const payments = payouts.rows.filter(p => p.manager_id === m.id && !p.voided_at);
    const sum = (items, key) => items.reduce((s, i) => s + Number(i[key]), 0);
    const earned = sum(current, 'amount_tetri');
    const paid = sum(payments.filter(p => p.commission_month === range.month), 'amount_tetri');
    return { ...m, providers: providers.rows.filter(p => p.referral_manager_id === m.id), earned, paid,
      base: sum(current, 'base_tetri'), count: current.length, due: earned - paid,
      previousDue: sum(all.filter(c => new Date(c.created_at) < range.start), 'amount_tetri') - sum(payments.filter(p => p.commission_month < range.month), 'amount_tetri'),
      commissions: current, payments: payouts.rows.filter(p => p.manager_id === m.id && p.commission_month === range.month) };
  });
  return { ...range, rows };
}
async function recordPayment(managerId, monthValue, amountValue, reference, requestKey) {
  const {month,start,end}=monthBounds(monthValue);
  const amount=decimalToInt(amountValue);
  if (!amount || month > monthBounds().month || typeof reference !== 'string' || reference.trim().length < 3 || reference.length > 300 || !/^[a-f0-9-]{36}$/.test(requestKey || '')) throw new PartnerError('Укажите сумму, месяц и подтверждение перевода.');
  return pool.withTransaction(async client => {
    if (!await getManager(managerId,client,true)) throw new PartnerError('Менеджер не найден.');
    const duplicate=(await client.query('SELECT * FROM manager_payouts WHERE request_key=$1',[requestKey])).rows[0];
    if (duplicate) {
      if (duplicate.manager_id !== managerId || duplicate.commission_month !== month || Number(duplicate.amount_tetri) !== amount || duplicate.reference !== reference.trim()) throw new PartnerError('Ключ выплаты уже использован для другой операции.');
      return duplicate;
    }
    const earned=Number((await client.query('SELECT COALESCE(SUM(amount_tetri),0) AS total FROM manager_commissions WHERE manager_id=$1 AND created_at >= $2 AND created_at < $3',[managerId,start,end])).rows[0].total);
    const paid=Number((await client.query('SELECT COALESCE(SUM(amount_tetri),0) AS total FROM manager_payouts WHERE manager_id=$1 AND commission_month=$2 AND voided_at IS NULL',[managerId,month])).rows[0].total);
    if(amount > earned-paid) throw new PartnerError('Сумма превышает остаток к выплате за выбранный месяц.');
    const row=(await client.query('INSERT INTO manager_payouts(manager_id,commission_month,amount_tetri,reference,request_key) VALUES($1,$2,$3,$4,$5) RETURNING *',[managerId,month,amount,reference.trim(),requestKey])).rows[0];
    await audit(client,managerId,'payment_recorded',{payout_id:row.id,amount_tetri:amount,month});
    return row;
  });
}
async function voidPayment(managerId, payoutId, reason) {
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 1000) throw new PartnerError('Укажите причину отмены записи выплаты.');
  return pool.withTransaction(async client => {
    if (!await getManager(managerId,client,true)) throw new PartnerError('Менеджер не найден.');
    const row=(await client.query('UPDATE manager_payouts SET voided_at=NOW(),void_reason=$3 WHERE id=$1 AND manager_id=$2 AND voided_at IS NULL RETURNING id',[payoutId,managerId,reason.trim()])).rows[0];
    if (!row) throw new PartnerError('Выплата не найдена или уже отменена.');
    await audit(client,managerId,'payment_voided',{payout_id:payoutId,reason:reason.trim()});
  });
}
module.exports={PartnerError,decimalToInt,monthBounds,getManager,createLink,setRate,findReferrer,bindNew,bindExisting,accrue,report,recordPayment,voidPayment};
