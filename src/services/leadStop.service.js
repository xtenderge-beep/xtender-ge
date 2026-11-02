const crypto = require('crypto');
const pool = require('../config/db');
const audit = require('./masterAudit.service');
const { getBaseUrl } = require('../config/url');

// Ссылка «Stop» в каждой SMS о заявке (ст. 12(3) и (6) закона о персональных данных: при каждой отправке —
// понятный способ отказаться). Открывается без входа: ей может воспользоваться и человек, к которому номер
// перешёл от исполнителя («Это не мой номер»). Код свой для пары «исполнитель и номер».
async function codeFor(master, client = pool) {
  const find = () => client.query('SELECT code FROM lead_stop_codes WHERE master_id=$1 AND phone=$2', [master.id, master.phone]);
  const existing = (await find()).rows[0];
  if (existing) return existing.code;
  await client.query('INSERT INTO lead_stop_codes(code, master_id, phone) VALUES($1,$2,$3) ON CONFLICT (master_id, phone) DO NOTHING',
    [crypto.randomBytes(6).toString('base64url'), master.id, master.phone]);
  return (await find()).rows[0].code;
}

async function linkFor(master, client = pool) {
  return `${getBaseUrl()}/stop/${await codeFor(master, client)}`;
}

async function find(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{6,16}$/.test(code)) return null;
  const row = (await pool.query(`SELECT s.code, s.phone AS stop_phone, m.id, m.phone, m.language, m.is_subscribed, m.marketing_sms
    FROM lead_stop_codes s JOIN masters m ON m.id = s.master_id WHERE s.code=$1`, [code])).rows[0];
  return row || null;
}

// «Больше не присылать» или «Это не мой номер». Если номер в профиле уже другой, на старый номер SMS и так
// не уходят. «Не мой номер» выключает и предложения, а модератор видит отметку в журнале действий.
async function stop(code, { notMine = false, meta = {} } = {}) {
  const row = await find(code);
  if (!row) return null;
  if (row.stop_phone !== row.phone) return { phone: row.stop_phone, changed: false };
  const reason = notMine ? 'not_my_number' : 'stop_link';
  await require('./leadSubscription.service').set(row.id, false, { source: 'sms_stop', actor: 'phone_holder', reason, meta });
  if (notMine) {
    await require('./smsPermissions.service').setMarketing(row.id, false, { source: 'sms_stop', actor: 'phone_holder', reason, meta });
    await audit.record(row.id, { actor: 'Владелец номера', action: 'phone_not_mine', body: 'По ссылке из SMS: «Это не мой номер». SMS на номер остановлены, проверьте профиль.' });
  }
  return { phone: row.stop_phone, changed: true };
}

module.exports = { codeFor, linkFor, find, stop };
