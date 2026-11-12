// Черновики анкет исполнителей от SMS-бота владельца (docs/outreach-bot-drafts.md).
// Бот создаёт черновик по API, сам отправляет короткую ссылку /c/<token>. Исполнитель на странице правит анкету,
// ставит те же галочки, что на /join, и подтверждает кодом из SMS сайта; дальше — обычная регистрация
// (masterService.registerMaster) и модерация. Сайт при создании черновика ничего не отправляет.
// До подтверждения анкета живёт только в provider_drafts.data; при подтверждении, отказе или по истечении срока
// data стирается: остаются номер, статус и даты — чтобы бот видел итог и не писал повторно.
const crypto = require('crypto');
const pool = require('../config/db');
const { phoneVariants, isGeorgianPhone } = require('../config/phone');
const { getBaseUrl } = require('../config/url');

const TTL_DAYS = 14;
const FREE_DAYS = 60;
const DAY_MS = 24 * 3600 * 1000;
// Без похожих символов (0/O, 1/I/L): ссылку могут переписывать руками. 31^8 ≈ 8,5·10^11.
const TOKEN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_LENGTH = 8;
const LANGS = ['ka', 'ru', 'en'];
const TYPE_TO_KIND = { master: 'worker', vehicle: 'vehicle', shop: 'store' };
const LIMITS = { name: 120, description: 2000, experience: 100, item: 100, items: 20, source: 80, externalId: 80, reason: 200 };

function fail(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, code, extra });
}

function randomFrom(alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
const newToken = () => randomFrom(TOKEN_ALPHABET, TOKEN_LENGTH);
const newPublicId = () => 'd_' + randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 8);
const confirmUrl = token => `${getBaseUrl()}/c/${token}`;
const isToken = value => typeof value === 'string' && new RegExp(`^[${TOKEN_ALPHABET}]{${TOKEN_LENGTH}}$`).test(value.toUpperCase());

// Любая запись грузинского номера → +995XXXXXXXXX. «+» в адресе запроса без кодирования приходит пробелом.
function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 9) digits = '995' + digits;
  const phone = '+' + digits;
  return isGeorgianPhone(phone) ? phone : null;
}

function json(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return fallback; } }
  return value;
}

function hasPhone(text) {
  return require('../config/phoneInText').hasPhone(text || '');
}

// Справочник для бота: только включённые услуги, те же коды, что в /llms.txt (service_categories.slug).
async function services(client = pool) {
  const rows = (await client.query('SELECT slug, name_ka, name_ru, name_en, is_active, sort_order FROM service_categories ORDER BY sort_order, slug')).rows;
  return rows.filter(row => row.is_active).map(row => ({ code: row.slug, name: { ka: row.name_ka, ru: row.name_ru, en: row.name_en } }));
}

async function cities(client = pool) {
  const rows = (await client.query('SELECT id, slug, name_ka, name_ru, name_en, is_active, sort_order FROM cities ORDER BY sort_order, id')).rows;
  return rows.filter(row => row.is_active);
}

// --- Проверка полей ---------------------------------------------------------------------------------------

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail('missing_field', `Field "${field}" is required.`, 400, { field });
    return '';
  }
  if (typeof value !== 'string') throw fail('invalid_field', `Field "${field}" must be a string.`, 400, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw fail('missing_field', `Field "${field}" is required.`, 400, { field });
  if (trimmed.length > max) throw fail('invalid_field', `Field "${field}" is longer than ${max} characters.`, 400, { field });
  return trimmed;
}

function list(value, field) {
  if (value === undefined || value === null) return [];
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(items) || items.length > LIMITS.items || items.some(item => typeof item !== 'string')) {
    throw fail('invalid_field', `Field "${field}" must be a list of up to ${LIMITS.items} strings.`, 400, { field });
  }
  const out = [...new Set(items.map(item => item.trim()).filter(Boolean))];
  if (out.some(item => item.length > LIMITS.item)) throw fail('invalid_field', `Items of "${field}" must be up to ${LIMITS.item} characters.`, 400, { field });
  return out;
}

async function serviceCodes(value, client) {
  const codes = list(value, 'services');
  const known = new Set((await services(client)).map(s => s.code));
  const unknown = codes.filter(code => !known.has(code));
  if (unknown.length) throw fail('unknown_service', `Unknown service codes: ${unknown.join(', ')}. See GET /api/outreach/services.`, 400, { unknown });
  return codes;
}

// city: название на любом из трёх языков, slug или id; можно списком. Только города, открытые на сайте.
async function cityIds(value, client) {
  if (value === undefined || value === null || value === '') return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length > 10 || items.some(item => typeof item !== 'string' && typeof item !== 'number')) throw fail('invalid_field', 'Field "city" must be a string or a list.', 400, { field: 'city' });
  const active = await cities(client);
  const ids = [];
  for (const item of items) {
    const key = String(item).trim().toLowerCase();
    const city = active.find(c => String(c.id) === key || [c.slug, c.name_ka, c.name_ru, c.name_en].some(name => String(name).toLowerCase() === key));
    if (!city) throw fail('unknown_city', `City "${item}" is not available. Available: ${active.map(c => c.name_en).join(', ')}.`, 400, { cities: active.map(c => ({ id: c.id, slug: c.slug, name: { ka: c.name_ka, ru: c.name_ru, en: c.name_en } })) });
    if (!ids.includes(city.id)) ids.push(city.id);
  }
  return ids;
}

function languages(value) {
  if (value === undefined || value === null) return null;
  const parsed = require('../config/spokenLanguages').parse(value);
  if (!parsed) throw fail('invalid_field', `Field "languages" must list codes from: ${Object.keys(require('../config/spokenLanguages').options).join(', ')}.`, 400, { field: 'languages' });
  return parsed;
}

function kinds(type, hasVehicle) {
  const types = type === undefined || type === null ? [] : Array.isArray(type) ? type : [type];
  if (types.some(item => !Object.hasOwn(TYPE_TO_KIND, item))) throw fail('invalid_field', 'Field "type" must be master, vehicle or shop.', 400, { field: 'type' });
  if (hasVehicle !== undefined && typeof hasVehicle !== 'boolean') throw fail('invalid_field', 'Field "has_vehicle" must be true or false.', 400, { field: 'has_vehicle' });
  const out = types.map(item => TYPE_TO_KIND[item]);
  if (hasVehicle === true) out.push('vehicle');
  return require('../config/providerKinds').KINDS.filter(kind => out.includes(kind));
}

function description(value, field = 'description', required = true) {
  const out = text(value, field, LIMITS.description, { required });
  if (hasPhone(out)) throw fail('description_has_phone', `Field "${field}" must not contain a phone number: customers open the number through the catalog.`, 400, { field });
  return out;
}

// Поля бота → data черновика. partial — PATCH: только присланные поля.
async function fromApi(body, { partial = false } = {}, client = pool) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('invalid_request', 'The request body must be a JSON object.');
  const has = key => Object.hasOwn(body, key);
  const data = {};
  if (has('name')) data.name = text(body.name, 'name', LIMITS.name);
  if (has('services')) data.services = await serviceCodes(body.services, client);
  if (has('other_services')) data.other_services = list(body.other_services, 'other_services');
  if (has('description') || !partial) data.description = description(body.description);
  if (has('experience')) {
    data.experience = text(body.experience, 'experience', LIMITS.experience);
    if (hasPhone(data.experience)) throw fail('description_has_phone', 'Field "experience" must not contain a phone number.', 400, { field: 'experience' });
  }
  if (has('city') || !partial) {
    data.city_ids = await cityIds(body.city, client);
    if (!data.city_ids) throw fail('missing_field', 'Field "city" is required.', 400, { field: 'city' });
  }
  if (has('districts')) data.districts = list(body.districts, 'districts');
  if (has('languages')) data.languages = languages(body.languages) || [];
  if (has('type') || has('has_vehicle')) data.kinds = kinds(body.type, body.has_vehicle);
  const meta = {};
  if (has('lang') || !partial) {
    if (!LANGS.includes(body.lang)) throw fail(has('lang') ? 'invalid_field' : 'missing_field', 'Field "lang" must be ka, ru or en.', 400, { field: 'lang' });
    meta.lang = body.lang;
  }
  if (has('source')) {
    meta.source = text(body.source, 'source', LIMITS.source);
    if (meta.source && !/^[A-Za-z0-9_.:-]+$/.test(meta.source)) throw fail('invalid_field', 'Field "source" may contain only Latin letters, digits and _ . : -', 400, { field: 'source' });
  }
  if (has('external_id')) meta.external_id = text(body.external_id, 'external_id', LIMITS.externalId) || null;
  return { data, meta };
}

function checkHasService(data) {
  if (!(data.services || []).length && !(data.other_services || []).length) {
    throw fail('missing_field', 'Send "services" or "other_services".', 400, { field: 'services' });
  }
}

// --- Статус по номеру -------------------------------------------------------------------------------------

async function findMaster(phone, client = pool) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const ph = variants.map((_, i) => `$${i + 1}`).join(', ');
  const rows = (await client.query(`SELECT id, phone, is_active, is_banned, banned_reason, free_until, created_at, is_subscribed, lead_sms_paused_at, telegram_id
    FROM masters WHERE phone IN (${ph}) ORDER BY id`, variants)).rows;
  return rows[0] || null;
}

async function findOptOut(phone, client = pool) {
  return (await client.query('SELECT * FROM outreach_optouts WHERE phone = $1', [phone])).rows[0] || null;
}

async function findDraft(phone, client = pool) {
  return (await client.query('SELECT * FROM provider_drafts WHERE phone = $1', [phone])).rows[0] || null;
}

function isExpired(draft, now = Date.now()) {
  return draft.status === 'draft' && new Date(draft.expires_at).getTime() <= now;
}

function draftStatus(draft) {
  if (!draft) return 'none';
  if (isExpired(draft)) return 'expired';
  if (draft.status === 'draft') return draft.opened_at ? 'opened' : 'draft';
  // Подтверждён, но профиля уже нет (удалён администратором): для бота номер снова свободен.
  if (draft.status === 'confirmed') return 'none';
  return draft.status;
}

function masterStatus(master) {
  if (master.is_banned) return 'rejected';
  return master.is_active ? 'active' : 'confirmed';
}

const iso = value => (value ? new Date(value).toISOString() : null);

async function status(phone, client = pool) {
  // По очереди: внутри транзакции это один клиент, параллельные запросы в нём pg запрещает.
  const master = await findMaster(phone, client);
  const optout = await findOptOut(phone, client);
  const draft = await findDraft(phone, client);
  let value;
  if (master) value = masterStatus(master);
  else if (optout) value = optout.source === 'page' ? 'declined' : 'opted_out';
  else value = draftStatus(draft);
  const linked = draft && master && draft.master_id === master.id;
  return {
    phone,
    status: value,
    draft_id: draft && value !== 'none' ? draft.public_id : null,
    confirmed_at: linked ? iso(draft.confirmed_at) : null,
    free_until: master ? iso(master.free_until) : null,
    // Отдельной публичной страницы исполнителя на сайте нет: профиль виден в каталоге.
    profile_url: null,
    // Придут ли заявки: SMS о заявках включены (галочка при подтверждении или позже в кабинете) и не на паузе;
    // telegram — привязан Telegram, туда заявки приходят и без SMS. Бот напоминает тем, у кого оба false.
    lead_sms: master ? master.is_subscribed === true && !master.lead_sms_paused_at : null,
    telegram: master ? Boolean(master.telegram_id) : null,
    ...(value === 'rejected' ? { reason: master.banned_reason || '' } : {}),
    ...(value === 'expired' ? { expired_at: iso(draft.closed_at || draft.expires_at) } : {}),
  };
}

// --- Создание и правка черновика ботом --------------------------------------------------------------------

function draftResponse(draft) {
  return { draft_id: draft.public_id, status: draftStatus(draft), confirm_url: confirmUrl(draft.token), expires_at: iso(draft.expires_at) };
}

async function guardPhone(phone, client) {
  const master = await findMaster(phone, client);
  if (master) throw fail('already_registered', 'A provider with this phone is already registered.', 409, { status: masterStatus(master) });
  if (await findOptOut(phone, client)) throw fail('opted_out', 'This phone asked not to be contacted.', 409);
}

async function create(body) {
  if (body?.provider_agreed !== true) {
    throw fail('provider_not_agreed', 'Set "provider_agreed": true only after the provider said yes to a profile in the chat.', 400, { field: 'provider_agreed' });
  }
  const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '');
  if (!phone) throw fail(body.phone === undefined ? 'missing_field' : 'invalid_phone', 'Field "phone" must be a Georgian number: +995 and 9 digits.', 400, { field: 'phone' });
  if (body.test !== undefined && typeof body.test !== 'boolean') throw fail('invalid_field', 'Field "test" must be true or false.', 400, { field: 'test' });
  const { data, meta } = await fromApi(body);
  checkHasService(data);
  return pool.withTransaction(async (client) => {
    await guardPhone(phone, client);
    await expireOld(client);
    const existing = await findDraft(phone, client);
    const now = new Date();
    if (existing && existing.status === 'draft') {
      // Тот же номер — тот же черновик и та же ссылка; срок ссылки не продлевается.
      const merged = { ...json(existing.data, {}), ...data };
      const row = (await client.query(`UPDATE provider_drafts SET data = $2::jsonb, lang = $3, source = $4, external_id = $5, is_test = $6, updated_at = $7
        WHERE id = $1 RETURNING *`, [existing.id, JSON.stringify(merged), meta.lang, meta.source ?? existing.source, meta.external_id ?? existing.external_id,
        body.test === true, now])).rows[0];
      return { created: false, draft: row };
    }
    // Нового черновика нет или прежний закрыт (истёк, профиль удалён): новая ссылка и новый срок.
    const values = [newPublicId(), newToken(), phone, JSON.stringify(data), meta.lang, meta.source || '', meta.external_id || null, body.test === true, now, new Date(now.getTime() + TTL_DAYS * DAY_MS)];
    let row;
    if (existing) {
      row = (await client.query(`UPDATE provider_drafts SET public_id = $1, token = $2, status = 'draft', data = $4::jsonb, lang = $5, source = $6, external_id = $7,
        is_test = $8, master_id = NULL, created_at = $9, updated_at = $9, opened_at = NULL, confirmed_at = NULL, closed_at = NULL, expires_at = $10
        WHERE phone = $3 RETURNING *`, values)).rows[0];
    } else {
      row = (await client.query(`INSERT INTO provider_drafts (public_id, token, phone, data, lang, source, external_id, is_test, created_at, updated_at, expires_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9, $10) RETURNING *`, values)).rows[0];
    }
    return { created: true, draft: row };
  });
}

async function update(publicId, body) {
  if (typeof publicId !== 'string' || !/^d_[a-z0-9]{8}$/.test(publicId)) throw fail('not_found', 'Draft not found.', 404);
  const { data, meta } = await fromApi(body, { partial: true });
  if (Object.hasOwn(body, 'phone')) throw fail('invalid_field', 'The phone of a draft cannot be changed: create a new draft.', 400, { field: 'phone' });
  return pool.withTransaction(async (client) => {
    await expireOld(client);
    const draft = (await client.query('SELECT * FROM provider_drafts WHERE public_id = $1 FOR UPDATE', [publicId])).rows[0];
    if (!draft) throw fail('not_found', 'Draft not found.', 404);
    if (draft.status !== 'draft') throw fail('not_editable', `The draft is ${draftStatus(draft)} and can no longer be changed.`, 409, { status: draftStatus(draft) });
    await guardPhone(draft.phone, client);
    const merged = { ...json(draft.data, {}), ...data };
    checkHasService(merged);
    const row = (await client.query(`UPDATE provider_drafts SET data = $2::jsonb, lang = $3, source = $4, external_id = $5, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [draft.id, JSON.stringify(merged), meta.lang || draft.lang, meta.source ?? draft.source, meta.external_id !== undefined ? meta.external_id : draft.external_id])).rows[0];
    return row;
  });
}

// Отказ: «нет / STOP» в переписке с ботом (source=bot) или «Не интересно» на странице (source=page).
// Анкета стирается, номер остаётся в списке отказа. Зарегистрированного исполнителя это не трогает.
async function optOut(phone, { reason = '', source = 'bot', meta = {} } = {}) {
  reason = text(reason, 'reason', LIMITS.reason);
  return pool.withTransaction(async (client) => {
    await client.query(`INSERT INTO outreach_optouts (phone, reason, source) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`, [phone, reason, source]);
    const draft = await findDraft(phone, client);
    if (draft && draft.status === 'draft') {
      await client.query(`UPDATE provider_drafts SET status = $2, data = '{}'::jsonb, closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [draft.id, source === 'page' ? 'declined' : 'opted_out']);
    }
    await require('./consentLog.service').recordAction({ eventType: 'OUTREACH_OPT_OUT', phone, metadata: { actor: source === 'page' ? 'provider' : 'bot', source, reason, draft_id: draft?.public_id || null },
      meta, channel: source === 'page' ? 'web' : 'api' }, client);
    return status(phone, client);
  });
}

// Черновики, которые не подтвердили за 14 дней: анкета стирается.
async function expireOld(client = pool) {
  const rows = (await client.query("SELECT id, expires_at, status FROM provider_drafts WHERE status = 'draft'")).rows;
  const now = Date.now();
  let count = 0;
  for (const row of rows) {
    if (!isExpired(row, now)) continue;
    await client.query(`UPDATE provider_drafts SET status = 'expired', data = '{}'::jsonb, closed_at = expires_at, updated_at = NOW() WHERE id = $1 AND status = 'draft'`, [row.id]);
    count++;
  }
  return count;
}

// Чьё состояние менялось после since: черновики, отказы и решения модератора по профилям из черновиков.
async function changes(since) {
  const from = new Date(since);
  if (!since || Number.isNaN(from.getTime())) throw fail('invalid_field', 'Query "since" must be an ISO date, e.g. 2026-11-13T00:00:00Z.', 400, { field: 'since' });
  await expireOld();
  const phones = new Map();
  const touch = (phone, at) => { const t = new Date(at); if (t > from && (!phones.has(phone) || phones.get(phone) < t)) phones.set(phone, t); };
  for (const row of (await pool.query('SELECT phone, updated_at FROM provider_drafts WHERE updated_at > $1', [from])).rows) touch(row.phone, row.updated_at);
  for (const row of (await pool.query('SELECT phone, created_at FROM outreach_optouts WHERE created_at > $1', [from])).rows) touch(row.phone, row.created_at);
  const events = (await pool.query(`SELECT d.phone, e.created_at FROM master_admin_events e JOIN provider_drafts d ON d.master_id = e.master_id WHERE e.created_at > $1`, [from])).rows;
  for (const row of events) touch(row.phone, row.created_at);
  const out = [];
  for (const [phone, at] of [...phones].sort((a, b) => a[1] - b[1]).slice(0, 1000)) {
    const current = await status(phone);
    out.push({ phone, status: current.status, lead_sms: current.lead_sms, telegram: current.telegram, changed_at: at.toISOString() });
  }
  return out;
}

// --- Страница /c/<token> ----------------------------------------------------------------------------------

async function byToken(token) {
  if (!isToken(token)) return null;
  await expireOld();
  return (await pool.query('SELECT * FROM provider_drafts WHERE token = $1', [token.toUpperCase()])).rows[0] || null;
}

async function markOpened(draft) {
  if (draft.status !== 'draft' || draft.opened_at) return;
  await pool.query('UPDATE provider_drafts SET opened_at = NOW(), updated_at = NOW() WHERE id = $1 AND opened_at IS NULL', [draft.id]);
}

// Правки исполнителя со страницы (до кода). final — перед отправкой кода: все обязательные поля на месте.
async function fromPage(body, { final = false } = {}) {
  const data = {};
  data.name = text(body.name, 'name', LIMITS.name);
  data.services = await serviceCodes(Array.isArray(body.services) ? body.services : body.services ? [body.services] : [], pool);
  data.other_services = list(body.otherServices || '', 'other_services');
  data.description = description(body.description, 'description', final);
  data.experience = text(body.experience || '', 'experience', LIMITS.experience);
  if (hasPhone(data.experience)) throw fail('description_has_phone', 'experience', 400, { field: 'experience' });
  const rawCities = Array.isArray(body.cityIds) ? body.cityIds : body.cityIds ? [body.cityIds] : [];
  const active = new Set((await cities()).map(c => c.id));
  data.city_ids = [...new Set(rawCities.map(Number))].filter(id => active.has(id));
  data.districts = list(body.districts || '', 'districts');
  const langs = Array.isArray(body.spokenLanguages) ? body.spokenLanguages : body.spokenLanguages ? [body.spokenLanguages] : [];
  data.languages = langs.length ? languages(langs) : [];
  if (final) {
    if (!data.name) throw fail('missing_field', 'name', 400, { field: 'name' });
    checkHasService(data);
    if (!data.city_ids.length) throw fail('missing_field', 'city', 400, { field: 'city' });
    if (!data.languages.length) throw fail('missing_field', 'languages', 400, { field: 'languages' });
  }
  return data;
}

async function saveEdits(draft, data) {
  const merged = { ...json(draft.data, {}), ...data };
  const row = (await pool.query(`UPDATE provider_drafts SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'draft' RETURNING *`, [draft.id, JSON.stringify(merged)])).rows[0];
  if (!row) throw fail('not_editable', 'not_editable', 409);
  return row;
}

// Код подтверждён: обычная регистрация с данными анкеты, затем отметки бота на профиле.
async function complete(draft, grant, { meta = {}, copy } = {}) {
  const data = json(draft.data, {});
  const masterService = require('./master.service');
  const fullDescription = data.experience ? `${data.description}\n\n${copy.experienceLine}: ${data.experience}` : data.description;
  const master = await masterService.registerMaster({
    createOnly: true, name: data.name, phone: draft.phone, description: fullDescription, serviceType: null,
    spokenLanguages: data.languages, cityId: data.city_ids[0], cityIds: data.city_ids, language: draft.lang,
    signupKinds: data.kinds || [], consentGrant: grant, requestMeta: meta,
  });
  const confirmedAt = new Date();
  const freeUntil = new Date(confirmedAt.getTime() + FREE_DAYS * DAY_MS);
  const source = draft.source || 'outreach';
  const hint = { draft_id: draft.public_id, services: data.services || [], other_services: data.other_services || [], districts: data.districts || [] };
  await pool.withTransaction(async (client) => {
    await client.query('UPDATE masters SET free_until = $2, signup_source = $3, signup_hint = $4::jsonb WHERE id = $1',
      [master.id, freeUntil, source, JSON.stringify(hint)]);
    // Проба бота: профиль сразу тестовый — в рабочие заявки и каталог он не попадает.
    if (draft.is_test === true) await client.query('UPDATE masters SET is_technical = true WHERE id = $1', [master.id]);
    await client.query(`UPDATE provider_drafts SET status = 'confirmed', master_id = $2, confirmed_at = $3, data = '{}'::jsonb, updated_at = $3 WHERE id = $1`,
      [draft.id, master.id, confirmedAt]);
  });
  Object.assign(master, { signup_hint: hint, signup_source: source, free_until: freeUntil, is_technical: master.is_technical || draft.is_test === true });
  return master;
}

// --- Админка ----------------------------------------------------------------------------------------------

async function adminRows({ source = '', status: wanted = '' } = {}) {
  await expireOld();
  const drafts = (await pool.query(`SELECT d.*, m.name AS master_name, m.is_active AS master_active, m.is_banned AS master_banned, m.free_until
    FROM provider_drafts d LEFT JOIN masters m ON m.id = d.master_id ORDER BY d.updated_at DESC, d.id DESC`)).rows;
  const optouts = (await pool.query('SELECT * FROM outreach_optouts ORDER BY created_at DESC')).rows;
  const rows = drafts.map(d => {
    let value = draftStatus(d);
    if (d.master_id && d.master_name !== null) value = d.master_banned ? 'rejected' : d.master_active ? 'active' : 'confirmed';
    const optout = optouts.find(o => o.phone === d.phone);
    if (!d.master_id && optout) value = optout.source === 'page' ? 'declined' : 'opted_out';
    return { ...d, data: json(d.data, {}), current: value };
  });
  for (const o of optouts) if (!drafts.some(d => d.phone === o.phone)) rows.push({ phone: o.phone, source: '', current: o.source === 'page' ? 'declined' : 'opted_out', updated_at: o.created_at, created_at: o.created_at, reason: o.reason, data: {}, is_test: false });
  const real = rows.filter(r => !r.is_test);
  const soon = Date.now() + 14 * DAY_MS;
  const stats = {
    created: real.filter(r => r.public_id).length,
    opened: real.filter(r => r.opened_at).length,
    confirmed: real.filter(r => r.confirmed_at).length,
    active: real.filter(r => r.current === 'active').length,
    declined: real.filter(r => r.current === 'declined').length,
    opted_out: real.filter(r => r.current === 'opted_out').length,
    expired: real.filter(r => r.current === 'expired').length,
    free_ending: real.filter(r => r.free_until && new Date(r.free_until).getTime() <= soon && new Date(r.free_until).getTime() > Date.now()).length,
  };
  const sources = [...new Set(rows.map(r => r.source).filter(Boolean))].sort();
  const shown = rows.filter(r => (!source || r.source === source) && (!wanted || r.current === wanted || (wanted === 'test' && r.is_test)));
  return { rows: shown, stats, sources };
}

// Ключ API бота: на сервере хранится только отпечаток; сам ключ показывается один раз при выпуске.
// OUTREACH_API_KEY в окружении — запасной путь (например, для отдельной тестовой копии).
const KEY_SETTING = 'outreach_api_key_hash';
const KEY_DATE_SETTING = 'outreach_api_key_at';
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

async function issueKey() {
  const key = 'xto_' + crypto.randomBytes(24).toString('base64url');
  const settings = require('./settings.service');
  await settings.setSetting(KEY_SETTING, sha256(key));
  await settings.setSetting(KEY_DATE_SETTING, new Date().toISOString());
  return key;
}

async function keyInfo() {
  const settings = require('./settings.service');
  const issuedAt = await settings.getSetting(KEY_DATE_SETTING, null);
  return { issuedAt: issuedAt ? new Date(issuedAt) : null, env: Boolean(process.env.OUTREACH_API_KEY) };
}

async function checkKey(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return false;
  const given = Buffer.from(sha256(raw), 'hex');
  const candidates = [];
  const stored = await require('./settings.service').getSetting(KEY_SETTING, null);
  if (stored && /^[a-f0-9]{64}$/.test(stored)) candidates.push(Buffer.from(stored, 'hex'));
  if (process.env.OUTREACH_API_KEY && process.env.OUTREACH_API_KEY.length >= 20) candidates.push(Buffer.from(sha256(process.env.OUTREACH_API_KEY), 'hex'));
  return candidates.some(candidate => crypto.timingSafeEqual(candidate, given));
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => expireOld().catch(err => console.error('[provider drafts] expire failed:', err.message));
  setTimeout(run, 60 * 1000).unref?.();
  timer = setInterval(run, 3600 * 1000);
  timer.unref?.();
}

module.exports = {
  TTL_DAYS, FREE_DAYS, fail, normalizePhone, isToken, confirmUrl, json,
  services, cities, status, create, update, optOut, expireOld, changes, draftResponse, draftStatus,
  byToken, markOpened, fromPage, saveEdits, complete, findMaster, findOptOut,
  adminRows, issueKey, keyInfo, checkKey, start,
};
