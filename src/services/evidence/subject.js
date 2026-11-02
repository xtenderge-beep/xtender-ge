const pool = require('../../config/db');
const { phoneVariants } = require('../../config/phone');

// Кто пользовался номером и когда. Номер не равен человеку: один номер мог быть у разных профилей и у заказчика,
// а профиль мог менять номер. Поэтому поиск не объединяет найденное: каждый профиль — отдельный субъект со своими
// периодами номера и тем, чем подтверждена связь; записи по номеру без доказанной связи с профилем — отдельный
// субъект «номер». Архив собирается по одному субъекту.

const tail = (phone) => String(phone || '').replace(/\D/g, '').slice(-9);
const tbilisi = (value) => new Date(new Date(value).getTime() + 4 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' (Тбилиси)';
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value) || {};
// События, в которых master_id — исполнитель, а номер — заказчика: они относятся к заказчику.
const CLIENT_EVENTS_WITH_PROVIDER = ['ORDER_CONTACT_RELEASED', 'ORDER_CONTACT_DENIED'];
const CODE_CONFIRMED = ['CONSENT_SMS_OTP_VERIFIED', 'AUTH_SMS_OTP_VERIFIED', 'LEAD_RESUME_OTP_VERIFIED'];

function placeholders(list, from = 1) {
  return list.map((_, index) => `$${index + from}`).join(', ');
}

// Записи журнала профиля: его собственные (master_id) и доказуемо связанные с ним без master_id — подтверждение
// регистрации (на него ссылается MASTER_REGISTERED) и отправки кодов с тем же номером сообщения шлюза.
async function profileRows(masterId) {
  const own = (await pool.query('SELECT * FROM sms_consent_logs WHERE master_id = $1 ORDER BY id', [masterId])).rows;
  const consentIds = own.filter((row) => row.event_type === 'MASTER_REGISTERED').map((row) => json(row.metadata).consent_log_id).filter(Boolean);
  const linked = consentIds.length
    ? (await pool.query(`SELECT * FROM sms_consent_logs WHERE id IN (${placeholders(consentIds)})`, consentIds)).rows : [];
  const refs = [...new Set([...own, ...linked].filter((row) => /OTP_VERIFIED$/.test(row.event_type) && row.otp_reference_id).map((row) => row.otp_reference_id))];
  // Пустые master_id отбираются в коде, не в SQL: тестовая база (pg-mem) ошибается на IS NULL по индексу.
  const sent = refs.length ? (await pool.query(`SELECT * FROM sms_consent_logs WHERE event_type = 'SMS_OTP_SENT'
    AND otp_reference_id IN (${placeholders(refs)})`, refs)).rows.filter((row) => !row.master_id) : [];
  const links = new Map();
  for (const row of linked) links.set(String(row.id), 'на эту запись ссылается создание профиля (MASTER_REGISTERED.consent_log_id)');
  for (const row of sent) links.set(String(row.id), 'тот же номер сообщения шлюза, что у подтверждённого кода профиля');
  const rows = [...own, ...linked, ...sent].sort((a, b) => Number(a.id) - Number(b.id));
  return { rows: [...new Map(rows.map((row) => [String(row.id), row])).values()], links };
}

// Периоды номеров профиля. Записанные смены (с 02.11.2026) — по событиям PHONE_CHANGED; более ранние смены не
// записывались, такие номера видны только по фактам (отправки, коды) и помечаются «по фактам, без записи о смене».
async function profile(masterId) {
  const master = (await pool.query('SELECT id, name, phone, created_at, terms_accepted_at, is_active, is_banned, is_subscribed, marketing_sms, lead_sms_paused_at, registration_language FROM masters WHERE id = $1', [masterId])).rows[0] || null;
  const { rows, links } = await profileRows(masterId);
  const registered = rows.find((row) => row.event_type === 'MASTER_REGISTERED');
  const deleted = rows.find((row) => row.event_type === 'MASTER_DELETED');
  const changes = rows.filter((row) => row.event_type === 'PHONE_CHANGED');
  const periods = [];
  if (registered) {
    const consent = rows.find((row) => String(row.id) === String(json(registered.metadata).consent_log_id));
    periods.push({ phone: registered.phone_number, from: registered.timestamp_utc, to: null, recorded: true,
      how: consent ? 'регистрация с кодом из SMS на этот номер' : 'регистрация; запись подтверждения кодом не найдена' });
  } else if (master || deleted) {
    const first = rows[0];
    periods.push({ phone: first ? first.phone_number : master?.phone, from: master?.created_at || first?.timestamp_utc || null, to: null, recorded: false,
      how: 'записи о регистрации в журнале нет (профиль создан до журнала или вручную); номер — по первой записи профиля' });
  }
  for (const change of changes) {
    const previous = periods[periods.length - 1];
    if (previous && !previous.to) previous.to = change.timestamp_utc;
    const actor = json(change.metadata).actor;
    const confirmed = rows.find((row) => CODE_CONFIRMED.includes(row.event_type) && tail(row.phone_number) === tail(change.phone_number)
      && new Date(row.timestamp_utc) >= new Date(change.timestamp_utc));
    periods.push({ phone: change.phone_number, from: change.timestamp_utc, to: null, recorded: true,
      how: `номер сменил ${actor === 'admin' ? 'администратор' : actor === 'provider' ? 'исполнитель' : actor || 'не указано'}; `
        + (confirmed ? `подтверждён кодом из SMS ${tbilisi(confirmed.timestamp_utc)}` : 'кодом из SMS не подтверждён') });
  }
  // Номера из фактов, которых нет среди записанных периодов (смена до 02.11.2026 или профиль без записи регистрации).
  const known = new Set(periods.map((period) => tail(period.phone)));
  const seen = new Map();
  for (const row of rows) {
    if (CLIENT_EVENTS_WITH_PROVIDER.includes(row.event_type) || row.event_type === 'PHONE_REPLACED') continue;
    const key = tail(row.phone_number);
    if (!key || known.has(key)) continue;
    const item = seen.get(key) || { phone: row.phone_number, from: row.timestamp_utc, to: row.timestamp_utc, records: 0 };
    item.to = row.timestamp_utc;
    item.records += 1;
    seen.set(key, item);
  }
  for (const item of seen.values()) periods.push({ phone: item.phone, from: item.from, to: item.to, recorded: false,
    how: `по фактам: ${item.records} записей профиля на этот номер между этими датами; записи о смене номера нет (смены до 02.11.2026 не записывались)` });
  if (master && !known.has(tail(master.phone)) && !seen.has(tail(master.phone))) {
    periods.push({ phone: master.phone, from: null, to: null, recorded: false, how: 'нынешний номер профиля; когда он появился, в журнале не записано' });
  }
  if (deleted) { const last = periods.filter((period) => !period.to).pop(); if (last) last.to = deleted.timestamp_utc; }
  periods.sort((a, b) => (a.from ? new Date(a.from) : 0) - (b.from ? new Date(b.from) : 0));
  return {
    id: Number(masterId), master, deletedAt: deleted ? deleted.timestamp_utc : null,
    name: master ? master.name : deleted ? json(deleted.metadata).name || null : null,
    phone: master ? master.phone : periods.length ? periods[periods.length - 1].phone : null,
    periods, rows, links,
  };
}

// Записи по номеру, которые доказуемо не принадлежат профилю: заказчик, коды без профиля.
async function phoneRows(raw, attributed = new Set()) {
  const variants = phoneVariants(raw);
  if (!variants.length) return { rows: [], orders: [] };
  const rows = (await pool.query(`SELECT * FROM sms_consent_logs WHERE phone_number IN (${placeholders(variants)}) ORDER BY id`, variants)).rows
    .filter((row) => !attributed.has(String(row.id)) && (!row.master_id || CLIENT_EVENTS_WITH_PROVIDER.includes(row.event_type)));
  const orders = (await pool.query(`SELECT id, status, district_name, description, created_at, confirmed_at, closed_at, closing_reason, is_technical
    FROM orders WHERE phone IN (${placeholders(variants)}) ORDER BY id`, variants)).rows;
  return { rows, orders };
}

// Поиск: номер в любом формате или «#123» — номер профиля. Ничего не объединяет, только перечисляет.
async function search(raw) {
  const text = String(raw || '').trim();
  const idMatch = /^#\s*(\d{1,9})$/.exec(text);
  if (idMatch) {
    const found = await profile(Number(idMatch[1]));
    if (!found.master && !found.rows.length) return { query: text, error: 'not_found' };
    return { query: text, profiles: [summarize(found)], phone: null, notes: [] };
  }
  if (!phoneVariants(text).length || tail(text).length < 9) return { query: text, error: 'invalid' };
  const found = await phoneSubject(text);
  const notes = [];
  if (found.profiles.length > 1) notes.push('Номером пользовались несколько профилей. Это разные профили; что за ними один человек, журнал не доказывает. Каждый выгружается отдельно.');
  if (found.profiles.length && (found.orders.length || found.rows.length)) notes.push('С этого номера есть записи без связи с профилем (заказчик или коды без регистрации). Что это тот же человек, что и исполнитель, журнал не доказывает: они выгружаются отдельным архивом «номер».');
  return { query: text, phone: found.phone, profiles: found.profiles, phoneOnly: { records: found.rows.length, orders: found.orders.length }, notes };
}

// Номер как субъект: профили, которые им пользовались (только перечень с периодами), и записи по номеру, которые
// ни одному профилю доказуемо не принадлежат.
async function phoneSubject(raw) {
  const variants = phoneVariants(raw);
  const key = tail(raw);
  const current = (await pool.query(`SELECT id FROM masters WHERE phone IN (${placeholders(variants)})`, variants)).rows.map((row) => Number(row.id));
  const touched = (await pool.query(`SELECT DISTINCT master_id, event_type FROM sms_consent_logs WHERE phone_number IN (${placeholders(variants)})`, variants)).rows
    .filter((row) => row.master_id && !CLIENT_EVENTS_WITH_PROVIDER.includes(row.event_type)).map((row) => Number(row.master_id));
  const ids = [...new Set([...current, ...touched])].sort((a, b) => a - b);
  const profiles = [];
  const attributed = new Set();
  for (const id of ids) {
    const found = await profile(id);
    found.rows.forEach((row) => attributed.add(String(row.id)));
    profiles.push({ ...summarize(found), usage: found.periods.filter((period) => tail(period.phone) === key) });
  }
  const own = await phoneRows(raw, attributed);
  return { phone: `+995${key}`, profiles, rows: own.rows, orders: own.orders };
}

function summarize(found) {
  return {
    id: found.id, name: found.name, phone: found.phone, deletedAt: found.deletedAt, exists: Boolean(found.master),
    createdAt: found.master ? found.master.created_at : null, records: found.rows.length,
    periods: found.periods.map((period) => ({ phone: period.phone, from: period.from, to: period.to, recorded: period.recorded, how: period.how })),
  };
}

module.exports = { search, profile, phoneSubject, summarize, tail, CLIENT_EVENTS_WITH_PROVIDER };
