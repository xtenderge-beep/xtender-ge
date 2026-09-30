// Статистика действий заказчиков с контактами исполнителей в каталоге (таблица catalog_contact_events,
// описание — в schema.sql). Запись никогда не ломает показ номера: ошибки только логируются.
const pool = require('../config/db');

const TYPES = new Set(['sms_gate', 'reveal', 'unavailable', 'rate_limited', 'contact']);
const CHANNELS = new Set(['show', 'call', 'whatsapp', 'viber', 'telegram']);
const PLACES = new Set(['card', 'dialog']);

function channel(value) { return CHANNELS.has(value) ? value : null; }

async function record({ masterId, callerPhone = null, type, channel: rawChannel = null, place = null, charged = false, technical = false }) {
  if (!TYPES.has(type) || !Number.isSafeInteger(Number(masterId))) return;
  try {
    await pool.query(
      `INSERT INTO catalog_contact_events (master_id, caller_phone, event_type, channel, place, charged, technical)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [Number(masterId), callerPhone, type, channel(rawChannel), PLACES.has(place) ? place : null, charged === true, technical === true]);
  } catch (err) {
    console.error('[catalog-stats] not recorded:', err.message);
  }
}

// Сводка для карточки исполнителя в админке.
async function summary(masterId) {
  const { rows } = await pool.query(
    `SELECT event_type, channel, charged, technical, COUNT(*)::int AS n
     FROM catalog_contact_events WHERE master_id = $1
     GROUP BY event_type, channel, charged, technical`, [masterId]);
  const result = { paid: 0, repeat: 0, technical: 0, smsGate: 0, unavailable: 0, rateLimited: 0, openedFrom: {}, contacts: {} };
  for (const row of rows) {
    if (row.event_type === 'reveal') {
      if (row.technical) result.technical += row.n;
      else if (row.charged) result.paid += row.n;
      else result.repeat += row.n;
      if (!row.technical && row.channel) result.openedFrom[row.channel] = (result.openedFrom[row.channel] || 0) + row.n;
    }
    if (row.event_type === 'sms_gate') result.smsGate += row.n;
    if (row.event_type === 'unavailable') result.unavailable += row.n;
    if (row.event_type === 'rate_limited') result.rateLimited += row.n;
    if (row.event_type === 'contact' && !row.technical && row.channel) result.contacts[row.channel] = (result.contacts[row.channel] || 0) + row.n;
  }
  return result;
}

module.exports = { record, summary, channel };
