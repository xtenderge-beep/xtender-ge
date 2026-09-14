const pool = require('../config/db');
const { toE164 } = require('../config/phone');
const consentLog = require('./consentLog.service');

function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\+?[\d\s()-]+$/.test(value.trim())) throw new Error('Укажите корректный номер телефона.');
  const phone = toE164(value);
  if (!/^\+[1-9]\d{8,14}$/.test(phone)) throw new Error('Укажите номер с кодом страны или грузинский номер из 9 цифр.');
  return phone;
}

async function isClientPhone(phone, client = pool) {
  const result = await client.query('SELECT phone FROM technical_client_phones WHERE phone=$1', [normalizePhone(phone)]);
  return result.rows.length > 0;
}

async function list() {
  const [clients, masters] = await Promise.all([
    pool.query('SELECT * FROM technical_client_phones ORDER BY created_at, phone'),
    pool.query('SELECT id,name,phone,category,is_active,is_banned,balance_tetri,telegram_id FROM masters WHERE is_technical=true ORDER BY id'),
  ]);
  return { clients: clients.rows, masters: masters.rows };
}

async function update(action, value, note = '', meta = {}) {
  if (!['add_client','remove_client','add_master','remove_master'].includes(action)) throw new Error('Неизвестное действие.');
  if (typeof note !== 'string' || note.trim().length > 200) throw new Error('Комментарий — до 200 символов.');
  return pool.withTransaction(async client => {
    let phone, masterId = null;
    if (action.endsWith('_client')) {
      phone = normalizePhone(value);
      if (action === 'add_client') await client.query('INSERT INTO technical_client_phones(phone,note) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET note=EXCLUDED.note', [phone,note.trim()]);
      else await client.query('DELETE FROM technical_client_phones WHERE phone=$1', [phone]);
    } else {
      if (action === 'add_master') {
        phone = normalizePhone(value);
        // Match legacy storage formats without conflating different country codes.
        const matches = (await client.query('SELECT id,phone FROM masters')).rows.filter(m=>toE164(m.phone) === phone);
        if (matches.length !== 1) throw new Error(matches.length ? 'Найдено несколько профилей с этим номером. Сначала исправьте дубли.' : 'Исполнитель не найден. Сначала зарегистрируйте его через сайт.');
        masterId = matches[0].id;
      } else {
        if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Некорректный исполнитель.');
        masterId = Number(value);
      }
      const master = (await client.query('SELECT * FROM masters WHERE id=$1 FOR UPDATE', [masterId])).rows[0];
      if (!master || (phone && toE164(master.phone) !== phone)) throw new Error('Профиль изменился. Обновите страницу.');
      phone = toE164(master.phone);
      await client.query('UPDATE masters SET is_technical=$2 WHERE id=$1', [masterId,action === 'add_master']);
    }
    await consentLog.recordAction({ eventType:'TECHNICAL_ROUTING_CHANGED', phone, masterId,
      metadata:{actor:'admin',action,note:note.trim()}, meta }, client);
  });
}

// Routing changes take this same row lock. A candidate selected before a role
// change is skipped; a change waits for a delivery already in progress to finish.
async function withMaster(id, isTechnical, fn) {
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT * FROM masters WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!master || master.is_technical !== isTechnical) return;
    return fn(master, client);
  });
}

module.exports = { normalizePhone, isClientPhone, list, update, withMaster };
