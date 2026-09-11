const crypto = require('crypto');
const pool = require('../config/db');
const settings = require('./settings.service');
const defaults = require('../config/payment');

function parseAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const amount = Math.round(Number(raw.replace(',', '.')) * 100);
  return Number.isSafeInteger(amount) && amount >= defaults.MIN_TOPUP_GEL * 100 && amount <= 100000 ? amount : null;
}
function validIban(value) {
  if (!/^GE\d{2}[A-Z]{2}\d{16}$/.test(value)) return false;
  const digits = (value.slice(4) + value.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55);
  let mod = 0;
  for (const c of digits) mod = (mod * 10 + Number(c)) % 97;
  return mod === 1;
}
async function getDetails() {
  const raw = await settings.getSetting('payment_details', null);
  return raw ? JSON.parse(raw) : { ...defaults };
}
async function saveDetails(input) {
  const keys = ['BANK_ACCOUNT','BANK_NAME','RECIPIENT_NAME','RECIPIENT_ID','RECIPIENT_ADDRESS','SWIFT','EMAIL','VAT_NOTE'];
  const details = { MIN_TOPUP_GEL: defaults.MIN_TOPUP_GEL };
  for (const key of keys) details[key] = String(input[key] || '').trim();
  details.BANK_ACCOUNT = details.BANK_ACCOUNT.replace(/\s/g, '').toUpperCase();
  details.SWIFT = details.SWIFT.toUpperCase();
  if (!validIban(details.BANK_ACCOUNT) || !/^\d{9,11}$/.test(details.RECIPIENT_ID) ||
      !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(details.SWIFT) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.EMAIL) ||
      keys.some(k => !details[k] || details[k].length > (k === 'RECIPIENT_ADDRESS' ? 400 : 180))) throw new Error('Invalid payment details');
  await settings.setSetting('payment_details', JSON.stringify(details));
  return details;
}
async function create(masterId, amount, key) {
  if (!Number.isSafeInteger(amount) || parseAmount(amount / 100) !== amount || !/^[a-f0-9-]{36}$/i.test(key || '')) throw new Error('Invalid top-up');
  const details = await getDetails();
  if (!validIban(details.BANK_ACCOUNT) || !details.RECIPIENT_ID) throw new Error('Payment details are incomplete');
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT id, name, is_banned FROM masters WHERE id = $1 FOR UPDATE', [masterId])).rows[0];
    if (!master || master.is_banned) throw new Error('Account unavailable');
    const existing = (await client.query('SELECT * FROM topup_requests WHERE master_id = $1 AND request_key = $2', [masterId, key])).rows[0];
    if (existing) {
      if (existing.amount_tetri !== amount) throw new Error('Request amount changed');
      return existing;
    }
    const reference = 'XT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const { rows } = await client.query(`INSERT INTO topup_requests(master_id, amount_tetri, reference, request_key, recipient, payer_name)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`, [masterId, amount, reference, key, JSON.stringify(details), master.name]);
    return rows[0];
  });
}
async function get(id, masterId) {
  return (await pool.query('SELECT * FROM topup_requests WHERE id = $1 AND master_id = $2', [id, masterId])).rows[0] || null;
}
async function list(masterId) {
  return (await pool.query('SELECT * FROM topup_requests WHERE master_id = $1 ORDER BY created_at DESC LIMIT 50', [masterId])).rows;
}
function purpose(topup) { return `Xtender balance ${topup.reference} / provider ${topup.master_id}`; }
module.exports = { parseAmount, validIban, getDetails, saveDetails, create, get, list, purpose };
