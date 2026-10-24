// Заявка как сделка (Tender API и страницы сайта) поверх той же таблицы orders — второй базы заявок нет. Черновик из API —
// строка orders со статусом unverified; публикация передаёт её модератору (pending_review), как заявку с сайта; рассылку
// по-прежнему разрешает модератор, и только тогда начинается сбор предложений (уточнение 2: срок не идёт на модерации).
// Статусы сделки (deal_status) и публикации — отдельные оси, см. docs/api-v1/WORKFLOWS.md.
const crypto = require('node:crypto');
const pool = require('../config/db');
const deal = require('../config/deal');
const requestFields = require('../config/requestFields');
const outbox = require('./outbox.service');
const access = require('./orderAccess.service');
const { generateShortId } = require('../config/shortId');

const { DealError, HOUR, LIMITS } = deal;
const newId = (prefix) => prefix + crypto.randomBytes(10).toString('hex');
const notFound = () => new DealError(404, 'NOT_FOUND', 'The request does not exist or is not accessible to this account.');
// JSONB-поле: объект (Postgres) или строка (значение по умолчанию в pg-mem тестов).
const json = (value, fallback) => (typeof value === 'string' ? JSON.parse(value) : value ?? fallback);

function apiId(order) { return 'tnd_' + order.id; }
function parseId(id) {
  const match = /^tnd_([1-9]\d{0,9})$/.exec(String(id || ''));
  return match ? Number(match[1]) : null;
}

// --- Статусы ---------------------------------------------------------------------------------------------------------
function collectionClosed(order, now = new Date()) {
  return Boolean(order.collection_closed_at) || Boolean(order.submission_deadline && new Date(order.submission_deadline) <= now);
}

function status(order, now = new Date()) {
  if (order.status === 'unverified') return 'draft';
  if (order.deal_status && order.deal_status !== 'open') return order.deal_status;
  if (order.deal_status === 'open') {
    // Закрыта прежним путём (заказчик со страницы заявки со звонками, модератор): «нашёл исполнителя» — выполнена.
    if (order.status === 'closed') return order.closing_reason === 'found_provider' ? 'completed' : 'cancelled';
    return collectionClosed(order, now) ? 'closed' : 'open';
  }
  return order.status === 'closed' ? 'closed' : 'open';
}

function publication(order) {
  if (order.status === 'unverified') return 'not_published';
  if (order.status === 'needs_revision') return 'needs_revision';
  if (order.first_dispatched_at || order.status === 'new') return 'published';
  if (order.status === 'pending_review') return 'in_review';
  return 'not_published';
}

function acceptsOffers(order, now = new Date()) {
  return ['offers', 'both'].includes(order.response_mode) && publication(order) === 'published' && order.status === 'new'
    && status(order, now) === 'open';
}

function acceptsMessages(order, now = new Date()) {
  return ['offers', 'both'].includes(order.response_mode) && publication(order) === 'published'
    && ['open', 'closed', 'selection_pending', 'awarded'].includes(status(order, now)) && order.status !== 'closed';
}

// --- Чтение -----------------------------------------------------------------------------------------------------------
async function items(orderId, client = pool) {
  return (await client.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY position', [orderId])).rows;
}

async function lockById(client, orderId) {
  return (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0] || null;
}

// Своя заявка аккаунта (только созданные через API с account_id: старые заявки по совпавшему номеру не открываются —
// уточнение 4).
async function forCustomer(account, tenderId, client = pool) {
  const id = parseId(tenderId);
  const order = id ? (await client.query('SELECT * FROM orders WHERE id=$1 AND account_id=$2', [id, account.id])).rows[0] : null;
  if (!order) throw notFound();
  return order;
}

async function forProvider(master, tenderId, client = pool) {
  const id = parseId(tenderId);
  const order = id ? (await client.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0] : null;
  if (!order || !master || !(await access.has(order.id, master.id, client))) throw notFound();
  return order;
}

// Заказчик или исполнитель с доступом; иначе один и тот же 404 — номер заявки не даёт доступа.
async function forViewer(viewer, tenderId) {
  const id = parseId(tenderId);
  const order = id ? (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0] : null;
  if (!order) throw notFound();
  if (viewer.account && order.account_id === viewer.account.id) return { order, role: 'customer' };
  if (viewer.master && await access.has(order.id, viewer.master.id)) return { order, role: 'provider' };
  throw notFound();
}

// --- Проверка входа ---------------------------------------------------------------------------------------------------
const ALLOWED = ['kind', 'title', 'description', 'language', 'category_ids', 'location', 'requested_start_at', 'requested_end_at',
  'collection_hours', 'timezone', 'budget', 'items', 'attributes', 'response_mode'];
const ITEM_KINDS = ['service', 'goods', 'delivery', 'unloading'];

function text(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max + 1) : null; }

// Лёгкая проверка формы: черновик может быть неполным, но не может быть неверным. Возвращает изменения для UPDATE.
async function parseInput(raw, client = pool) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DealError(400, 'INVALID_REQUEST', 'Send a JSON object.');
  const fields = [];
  const out = {};
  for (const key of Object.keys(raw)) if (!ALLOWED.includes(key)) fields.push({ path: key, code: 'UNKNOWN_FIELD' });
  const str = (key, max) => {
    if (raw[key] === undefined) return;
    if (raw[key] === null) { out[key] = null; return; }
    const value = text(raw[key], max);
    if (value === null || value.length > max) fields.push({ path: key, code: 'INVALID_VALUE' }); else out[key] = value;
  };
  str('title', LIMITS.title);
  str('description', LIMITS.description);
  if (raw.kind !== undefined) { if (!deal.KINDS.includes(raw.kind)) fields.push({ path: 'kind', code: 'INVALID_OPTION' }); else out.kind = raw.kind; }
  if (raw.language !== undefined) { if (!['ka', 'ru', 'en'].includes(raw.language)) fields.push({ path: 'language', code: 'INVALID_OPTION' }); else out.language = raw.language; }
  if (raw.response_mode !== undefined) { if (!deal.RESPONSE_MODES.includes(raw.response_mode)) fields.push({ path: 'response_mode', code: 'INVALID_OPTION' }); else out.response_mode = raw.response_mode; }
  if (raw.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: raw.timezone }); out.timezone = String(raw.timezone).slice(0, 64); } catch { fields.push({ path: 'timezone', code: 'INVALID_VALUE' }); }
  }
  for (const key of ['requested_start_at', 'requested_end_at']) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) { out[key] = null; continue; }
    const at = Date.parse(raw[key]);
    if (Number.isNaN(at) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(raw[key]))) fields.push({ path: key, code: 'INVALID_DATE' }); else out[key] = new Date(at);
  }
  if (raw.collection_hours !== undefined) {
    const n = raw.collection_hours;
    if (raw.collection_hours === null) out.collection_hours = null;
    else if (!Number.isInteger(n) || n < deal.COLLECTION_HOURS.min || n > deal.COLLECTION_HOURS.max) fields.push({ path: 'collection_hours', code: 'OUT_OF_RANGE' });
    else out.collection_hours = n;
  }
  if (raw.budget !== undefined) {
    const b = raw.budget;
    if (b === null) { out.budget_max_minor = null; out.budget_visibility = null; }
    else if (typeof b !== 'object' || (b.currency !== undefined && b.currency !== 'GEL') || (b.max_amount_minor != null && !deal.isMinor(b.max_amount_minor))
      || (b.visibility !== undefined && !['providers', 'private'].includes(b.visibility))) fields.push({ path: 'budget', code: 'INVALID_VALUE' });
    else { out.budget_max_minor = b.max_amount_minor ?? null; out.budget_visibility = b.visibility || 'providers'; }
  }
  if (raw.category_ids !== undefined) {
    if (!Array.isArray(raw.category_ids) || raw.category_ids.length > 10 || raw.category_ids.some((c) => typeof c !== 'string')) fields.push({ path: 'category_ids', code: 'INVALID_VALUE' });
    else {
      const known = new Map((await require('./category.service').list(client)).map((c) => [c.slug, c]));
      raw.category_ids.forEach((c, i) => { if (!known.has(c)) fields.push({ path: `category_ids[${i}]`, code: 'UNKNOWN_CATEGORY' }); });
      out.requested_categories = [...new Set(raw.category_ids)];
    }
  }
  if (raw.location !== undefined) {
    const loc = raw.location;
    if (!loc || typeof loc !== 'object') fields.push({ path: 'location', code: 'INVALID_VALUE' });
    else {
      const catalog = require('./apiCatalog.service');
      if (loc.country_code !== undefined && loc.country_code !== 'GE') fields.push({ path: 'location.country_code', code: 'INVALID_OPTION' });
      if (loc.city_id !== undefined) {
        const city = await catalog.resolveLocation(loc.city_id);
        if (!city || city.type !== 'city') fields.push({ path: 'location.city_id', code: 'UNKNOWN_LOCATION' }); else out.city_slug = city.id.slice(5);
      }
      if (loc.district_id !== undefined && loc.district_id !== null) {
        const district = await catalog.resolveLocation(loc.district_id);
        if (!district || district.type !== 'district') fields.push({ path: 'location.district_id', code: 'UNKNOWN_LOCATION' });
        else { out.district_slug = district.id.slice(9); out.district_label = district.names; }
      }
      if (loc.public_area_label !== undefined) { const v = text(loc.public_area_label, 80); if (v === null || v.length > 80) fields.push({ path: 'location.public_area_label', code: 'INVALID_VALUE' }); else out.district_name = v; }
      if (loc.private_address !== undefined) {
        if (loc.private_address === null) out.private_address = null;
        else { const v = text(loc.private_address, LIMITS.address); if (v === null || v.length > LIMITS.address) fields.push({ path: 'location.private_address', code: 'INVALID_VALUE' }); else out.private_address = v; }
      }
    }
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items) || raw.items.length > LIMITS.items) fields.push({ path: 'items', code: 'INVALID_VALUE' });
    else {
      out.items = [];
      raw.items.forEach((item, i) => {
        const at = `items[${i}]`;
        if (!item || typeof item !== 'object') { fields.push({ path: at, code: 'INVALID_VALUE' }); return; }
        const name = text(item.name, LIMITS.itemName);
        const kind = item.kind || 'goods';
        if (!name || name.length > LIMITS.itemName) fields.push({ path: `${at}.name`, code: 'REQUIRED' });
        if (!ITEM_KINDS.includes(kind)) fields.push({ path: `${at}.kind`, code: 'INVALID_OPTION' });
        const quantity = item.quantity === undefined || item.quantity === null || item.quantity === '' ? null : String(item.quantity).trim();
        if (quantity !== null && !/^\d{1,9}(\.\d{1,3})?$/.test(quantity)) fields.push({ path: `${at}.quantity`, code: 'INVALID_DECIMAL' });
        const unit = item.unit === undefined || item.unit === null || item.unit === '' ? null : require('../config/units').codeFor(String(item.unit));
        if (item.unit && !unit) fields.push({ path: `${at}.unit`, code: 'UNKNOWN_UNIT' });
        const specs = item.specifications === undefined || item.specifications === null ? {} : item.specifications;
        if (typeof specs !== 'object' || Array.isArray(specs) || JSON.stringify(specs).length > 2000) fields.push({ path: `${at}.specifications`, code: 'INVALID_VALUE' });
        out.items.push({ kind, name, quantity, unit, category_id: typeof item.category_id === 'string' ? item.category_id.slice(0, 32) : null,
          specifications: specs, substitutions_allowed: item.substitutions_allowed === true, required: item.required !== false });
      });
    }
  }
  if (raw.attributes !== undefined) {
    if (!raw.attributes || typeof raw.attributes !== 'object' || Array.isArray(raw.attributes)) fields.push({ path: 'attributes', code: 'INVALID_VALUE' });
    else {
      const list = await require('./category.service').list(client);
      out.request_attributes = {};
      for (const [slug, values] of Object.entries(raw.attributes)) {
        const category = list.find((c) => c.slug === slug);
        if (!category) { fields.push({ path: `attributes.${slug}`, code: 'UNKNOWN_CATEGORY' }); continue; }
        const checked = requestFields.validateValues(category, values, `attributes.${slug}`);
        fields.push(...checked.errors);
        out.request_attributes[slug] = checked.values;
      }
    }
  }
  if (fields.length) throw new DealError(422, 'VALIDATION_FAILED', 'Some fields are invalid.', { fields });
  return out;
}

// Колонки orders из разобранного входа (город и район — по кодам справочника).
async function columnsFrom(parsed, client) {
  const cols = {};
  for (const key of ['kind', 'title', 'response_mode', 'timezone', 'requested_start_at', 'requested_end_at', 'collection_hours', 'budget_max_minor',
    'budget_visibility', 'private_address', 'requested_categories', 'request_attributes']) if (parsed[key] !== undefined) cols[key] = parsed[key];
  if (parsed.description !== undefined) cols.original_text = parsed.description;
  if (parsed.language !== undefined) cols.source_lang = parsed.language;
  if (parsed.city_slug) cols.city_id = (await client.query('SELECT id FROM cities WHERE slug=$1', [parsed.city_slug])).rows[0]?.id || null;
  if (parsed.district_slug) cols.district_id = (await client.query('SELECT id FROM districts WHERE slug=$1', [parsed.district_slug])).rows[0]?.id || null;
  if (parsed.district_name !== undefined) cols.district_name = parsed.district_name || '';
  else if (parsed.district_label) cols.district_name = parsed.district_label.en || parsed.district_label.ru;
  return cols;
}

async function writeItems(client, orderId, list) {
  await client.query('DELETE FROM order_items WHERE order_id=$1', [orderId]);
  for (const [i, item] of list.entries()) {
    await client.query(
      `INSERT INTO order_items (id, order_id, position, kind, category_id, name, quantity, unit, specifications, substitutions_allowed, required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [newId('itm_'), orderId, i + 1, item.kind, item.category_id, item.name, item.quantity, item.unit, JSON.stringify(item.specifications), item.substitutions_allowed, item.required]);
  }
}

// Текст заявки для модератора и исполнителей (их экраны читают orders.description): исходный текст заказчика и
// структурированные поля одним понятным текстом на языке заявки. Номера телефонов здесь не бывает — телефон отдельно.
async function describe(order, list, client = pool) {
  const lang = ['ka', 'ru', 'en'].includes(order.source_lang) ? order.source_lang : 'ru';
  const words = {
    ru: { items: 'Позиции', params: 'Параметры', start: 'Начало', end: 'Окончание', budget: 'Бюджет до', mode: 'Ответ',
      modes: { calls: 'звонок заказчику', offers: 'письменные предложения на xtender.ge (телефон после выбора)', both: 'звонок или письменное предложение' }, subs: 'замена допустима' },
    ka: { items: 'პოზიციები', params: 'პარამეტრები', start: 'დაწყება', end: 'დასრულება', budget: 'ბიუჯეტი', mode: 'პასუხი',
      modes: { calls: 'დარეკეთ დამკვეთს', offers: 'წერილობითი შეთავაზება xtender.ge-ზე (ტელეფონი არჩევის შემდეგ)', both: 'დარეკვა ან წერილობითი შეთავაზება' }, subs: 'შეცვლა დასაშვებია' },
    en: { items: 'Items', params: 'Details', start: 'Start', end: 'Finish', budget: 'Budget up to', mode: 'Reply',
      modes: { calls: 'call the customer', offers: 'written offers on xtender.ge (phone after selection)', both: 'call or written offer' }, subs: 'substitutes allowed' },
  }[lang];
  const units = require('../config/units');
  const categories = await require('./category.service').list(client);
  const lines = [];
  if (order.title) lines.push(order.title);
  if (order.original_text) lines.push(order.original_text);
  if (list.length) {
    lines.push(words.items + ':');
    for (const item of list) {
      const unit = item.unit ? units.view(units.UNITS.find((u) => u.code === item.unit), lang).short : '';
      const specs = Object.entries(item.specifications || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      lines.push(`- ${item.name}${item.quantity ? ' — ' + item.quantity + (unit ? ' ' + unit : '') : ''}${specs ? ' (' + specs + ')' : ''}${item.substitutions_allowed ? ' · ' + words.subs : ''}`);
    }
  }
  for (const [slug, values] of Object.entries(order.request_attributes || {})) {
    const category = categories.find((c) => c.slug === slug);
    const fields = requestFields.forCategory(category);
    const parts = Object.entries(values || {}).map(([key, value]) => {
      const field = fields.find((f) => f.key === key);
      return field ? `${requestFields.label(field, lang)} — ${requestFields.valueLabel(field, value, lang)}` : null;
    }).filter(Boolean);
    if (parts.length) lines.push(`${words.params} (${category?.['name_' + lang] || slug}): ${parts.join('; ')}`);
  }
  if (order.requested_start_at) lines.push(`${words.start}: ${deal.formatLocal(order.requested_start_at, lang, order.timezone)}`);
  if (order.requested_end_at) lines.push(`${words.end}: ${deal.formatLocal(order.requested_end_at, lang, order.timezone)}`);
  if (order.budget_max_minor != null && order.budget_visibility === 'providers') lines.push(`${words.budget} ${deal.minorToGel(order.budget_max_minor)} ₾`);
  lines.push(`${words.mode}: ${words.modes[order.response_mode] || words.modes.calls}`);
  return lines.join('\n').slice(0, 6000);
}

// --- Черновик ---------------------------------------------------------------------------------------------------------
async function createDraft(account, raw, { channel = 'api' } = {}) {
  const parsed = await parseInput(raw);
  return pool.withTransaction(async (client) => {
    const cols = await columnsFrom(parsed, client);
    // Новые заявки из ChatGPT по умолчанию — «сначала предложения» (решение 4); заказчик может выбрать звонки или оба.
    if (!cols.response_mode) cols.response_mode = channel === 'chatgpt' || channel === 'api' ? 'offers' : 'calls';
    if (!cols.source_lang) cols.source_lang = account.locale;
    const row = (await client.query(
      `INSERT INTO orders (phone, description, district_name, token, owner_token, target_categories, status, channel, account_id, deal_updated_at)
       VALUES ($1, '', '', $2, $3, '{}', 'unverified', $4, $5, NOW()) RETURNING *`,
      [account.phone, generateShortId(), generateShortId(), deal.CHANNELS.includes(channel) ? channel : 'api', account.id])).rows[0];
    await applyColumns(client, row.id, cols);
    if (parsed.items) await writeItems(client, row.id, parsed.items);
    const order = await lockById(client, row.id);
    // Версии схем на момент сохранения: по ним публикация заметит, что категорию изменили (validate.schema_changes).
    await client.query('UPDATE orders SET description=$2, schema_versions=$3::jsonb WHERE id=$1',
      [row.id, await describe(order, await items(row.id, client), client), JSON.stringify(await draftSchemaVersions(order.requested_categories))]);
    return lockById(client, row.id);
  });
}

async function applyColumns(client, orderId, cols) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  const json = new Set(['requested_categories', 'request_attributes']);
  const sets = keys.map((key, i) => `${key} = $${i + 2}${json.has(key) ? '::jsonb' : ''}`);
  await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, [orderId, ...keys.map((key) => (json.has(key) ? JSON.stringify(cols[key]) : cols[key]))]);
}

function checkVersion(order, expected) {
  if (String(order.api_version) !== String(expected)) {
    throw new DealError(412, 'VERSION_MISMATCH', 'The request has changed since you read it. Read it again and repeat the change.', { details: { current_version: order.api_version } });
  }
}

async function updateDraft(account, tenderId, expected, raw) {
  const parsed = await parseInput(raw);
  const own = await forCustomer(account, tenderId);
  return pool.withTransaction(async (client) => {
    const order = await lockById(client, own.id);
    checkVersion(order, expected);
    if (order.status !== 'unverified') {
      throw new DealError(409, 'ACTION_NOT_ALLOWED', 'Only a draft can be edited. After publication the terms are frozen: cancel the request and create a new one.');
    }
    await applyColumns(client, order.id, await columnsFrom(parsed, client));
    if (parsed.items) await writeItems(client, order.id, parsed.items);
    const fresh = await lockById(client, order.id);
    await client.query('UPDATE orders SET description=$2, schema_versions=$3::jsonb, api_version = api_version + 1, deal_updated_at = NOW() WHERE id=$1',
      [order.id, await describe(fresh, await items(order.id, client), client), JSON.stringify(await draftSchemaVersions(fresh.requested_categories))]);
    return lockById(client, order.id);
  });
}

// --- Проверка перед публикацией -----------------------------------------------------------------------------------
async function validate(order, list, client = pool, now = new Date()) {
  const categories = await require('./category.service').list(client);
  const catalog = require('./apiCatalog.service');
  const units = require('../config/units');
  const snap = await catalog.snapshot();
  const missing = [];
  const errors = [];
  const warnings = [];
  const requested = json(order.requested_categories, []);
  const attributes = json(order.request_attributes, {});
  if (!order.title && !order.original_text) missing.push('title');
  if (!requested.length) missing.push('category_ids');
  if (!order.city_id) missing.push('location.city_id');
  else {
    const city = (await client.query('SELECT is_active FROM cities WHERE id=$1', [order.city_id])).rows[0];
    if (!city?.is_active) errors.push({ path: 'location.city_id', code: 'CITY_NOT_SERVED' });
  }
  const schemaVersions = {};
  requested.forEach((slug, i) => {
    const category = categories.find((c) => c.slug === slug);
    if (!category) { errors.push({ path: `category_ids[${i}]`, code: 'UNKNOWN_CATEGORY', category_id: slug }); return; }
    if (!category.is_active) errors.push({ path: `category_ids[${i}]`, code: 'CATEGORY_INACTIVE', category_id: slug });
    schemaVersions[slug] = snap.categories.find((c) => c.slug === slug)?.schema_version || null;
    const values = attributes[slug] || {};
    for (const key of requestFields.requiredKeys(category)) if (values[key] === undefined) missing.push(`attributes.${slug}.${key}`);
    if (category.kind === 'goods' && !list.some((item) => item.kind === 'goods')) missing.push('items');
  });
  // Все сохранённые значения — заново по текущей схеме категории: тип, допустимые варианты, диапазон. Устаревшее не
  // исправляется молча — заказчик (или ассистент) получает перечень того, что поправить.
  for (const [slug, values] of Object.entries(attributes)) {
    const category = categories.find((c) => c.slug === slug);
    if (!requested.includes(slug)) { errors.push({ path: `attributes.${slug}`, code: 'CATEGORY_NOT_SELECTED', category_id: slug }); continue; }
    if (!category) continue;
    errors.push(...requestFields.validateValues(category, values, `attributes.${slug}`).errors.map((error) => ({ ...error, ...fieldHelp(category, error.path) })));
  }
  const kind = order.kind || 'service';
  if (['goods', 'mixed'].includes(kind)) {
    if (!list.some((item) => item.kind === 'goods')) missing.push('items');
    list.forEach((item, i) => { if (item.kind === 'goods' && (!item.quantity || !item.unit)) errors.push({ path: `items[${i}]`, code: 'QUANTITY_AND_UNIT_REQUIRED' }); });
  }
  list.forEach((item, i) => {
    if (item.unit && !units.UNITS.some((u) => u.code === item.unit)) errors.push({ path: `items[${i}].unit`, code: 'UNKNOWN_UNIT', allowed: units.UNITS.map((u) => u.code) });
    if (item.category_id && !categories.some((c) => c.slug === item.category_id && c.is_active)) errors.push({ path: `items[${i}].category_id`, code: 'UNKNOWN_CATEGORY', category_id: item.category_id });
  });
  if (order.requested_start_at && new Date(order.requested_start_at) <= now) errors.push({ path: 'requested_start_at', code: 'IN_THE_PAST' });
  if (order.requested_end_at && order.requested_start_at && new Date(order.requested_end_at) < new Date(order.requested_start_at)) errors.push({ path: 'requested_end_at', code: 'BEFORE_START' });
  // Срок сбора согласуем с датой работ (решение 5): если до начала меньше, чем длится сбор, сбор сократится.
  const hours = order.collection_hours || deal.COLLECTION_HOURS.default;
  if (order.requested_start_at) {
    const left = (new Date(order.requested_start_at) - now) / HOUR - deal.START_MARGIN_HOURS.collection;
    if (left < 1) errors.push({ path: 'requested_start_at', code: 'TOO_SOON_FOR_OFFERS', hint: 'Choose response_mode calls for urgent jobs or a later start.' });
    else if (left < hours) warnings.push({ code: 'COLLECTION_SHORTENED', message: `Offers will be collected for about ${Math.floor(left)} h so that the provider is chosen before the start.` });
  }
  if (order.response_mode === 'offers' && require('../config/phoneInText').hasPhone(`${order.original_text || ''} ${order.title || ''}`)) {
    warnings.push({ code: 'PHONE_IN_TEXT', message: 'The text contains a phone number although the phone is hidden until a provider is chosen.' });
  }
  // Схема категории изменилась с тех пор, как черновик сохранили: какие категории и с какой версии на какую.
  const saved = json(order.schema_versions, {}) || {};
  const schemaChanges = Object.entries(schemaVersions).filter(([slug, current]) => saved[slug] && saved[slug] !== current)
    .map(([slug, current]) => ({ category_id: slug, saved_version: saved[slug], current_version: current }));
  const uniqueMissing = [...new Set(missing)];
  return { ready_to_publish: !uniqueMissing.length && !errors.length, missing_fields: uniqueMissing, field_errors: errors, warnings, schema_versions: schemaVersions,
    schema_changes: schemaChanges, fixes: fixesFor(uniqueMissing, errors) };
}

// Подсказка к ошибке параметра: допустимые варианты, границы, единица — из текущей схемы.
function fieldHelp(category, path) {
  const key = String(path).split('.').pop();
  const field = requestFields.forCategory(category).find((f) => f.key === key);
  if (!field) return {};
  return { ...(field.options ? { allowed: field.options } : {}), ...(field.min != null ? { min: field.min } : {}), ...(field.max != null ? { max: field.max } : {}),
    ...(field.unit ? { unit: require('../config/units').codeFor(field.unit) || field.unit } : {}) };
}

// Перечень исправлений простыми словами — для заказчика и ассистента (по-английски: его читает модель).
function fixesFor(missing, errors) {
  const range = (e) => [e.min != null ? `from ${e.min}` : '', e.max != null ? `to ${e.max}` : '', e.unit || ''].filter(Boolean).join(' ');
  const messages = {
    UNKNOWN_PARAMETER: (e) => `${e.path} is not a parameter of this category any more; remove it (read the category schema again).`,
    INVALID_OPTION: (e) => `${e.path}: the value is not allowed any more; choose one of: ${(e.allowed || []).join(', ')}.`,
    OUT_OF_RANGE: (e) => `${e.path}: give a number ${range(e)}.`,
    INVALID_VALUE: (e) => `${e.path}: the value has the wrong type for this parameter.`,
    INVALID_DATE: (e) => `${e.path}: give a date in RFC 3339 format.`,
    CATEGORY_INACTIVE: (e) => `${e.path}: category ${e.category_id} is no longer available; choose another category.`,
    UNKNOWN_CATEGORY: (e) => `${e.path}: category ${e.category_id || ''} does not exist; search the catalog again.`,
    CATEGORY_NOT_SELECTED: (e) => `${e.path}: parameters are given for a category that is not in category_ids; remove them or add the category.`,
    UNKNOWN_UNIT: (e) => `${e.path}: use a unit code from listUnits.`,
    QUANTITY_AND_UNIT_REQUIRED: (e) => `${e.path}: goods need a quantity and a unit.`,
    CITY_NOT_SERVED: () => 'location.city_id: Xtender does not serve this city now; choose a served city.',
    IN_THE_PAST: (e) => `${e.path}: the date is in the past.`,
    BEFORE_START: (e) => `${e.path}: the end is before the start.`,
    TOO_SOON_FOR_OFFERS: () => 'requested_start_at: too soon to collect written offers; choose a later start or response_mode calls.',
  };
  return [
    ...missing.map((path) => ({ path, code: 'REQUIRED', message: `${path} is required.` })),
    ...errors.map((e) => ({ ...e, message: (messages[e.code] || ((x) => `${x.path}: ${x.code}.`))(e) })),
  ];
}

// Версии схем выбранных категорий на момент сохранения черновика — по ним публикация замечает, что схема изменилась.
async function draftSchemaVersions(requested) {
  const snap = await require('./apiCatalog.service').snapshot();
  return Object.fromEntries((requested || []).map((slug) => [slug, snap.categories.find((c) => c.slug === slug)?.schema_version || null]));
}

// --- Публикация -------------------------------------------------------------------------------------------------------
async function publish(account, tenderId, expected, meta = {}) {
  const own = await forCustomer(account, tenderId);
  const consent = require('./accountConsent.service');
  if (own.status !== 'unverified') {
    // Повтор публикации уже опубликованной заявки ничего не делает второй раз (идемпотентность сверх Idempotency-Key).
    if (own.status === 'closed') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'The request is closed.');
    return { order: own, already: true };
  }
  const state = await consent.state(account);
  if (!state.accepted) {
    throw new DealError(409, 'CONSENT_REQUIRED', 'Before the first publication the customer accepts the Terms and Privacy policy on xtender.ge. Give the user the consent_url, then publish again.',
      { details: { consent_url: await consent.createLink(account, apiId(own)) } });
  }
  const published = await pool.withTransaction(async (client) => {
    const order = await lockById(client, own.id);
    checkVersion(order, expected);
    if (order.status !== 'unverified') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'The request is already published.');
    const list = await items(order.id, client);
    const check = await validate(order, list, client);
    if (!check.ready_to_publish) {
      // Схема категории поменялась после сохранения черновика, и черновик ей больше не соответствует — конфликт с
      // перечнем исправлений. Ничего не исправляется молча.
      if (check.schema_changes.length) {
        throw new DealError(409, 'CATEGORY_SCHEMA_CHANGED', 'The category changed after the draft was saved and the draft no longer fits it. Show the user the fixes, read the category schema again, update the draft and publish again.',
          { details: { schema_changes: check.schema_changes, fixes: check.fixes, validation: check } });
      }
      throw new DealError(422, 'NOT_READY', 'The request is not ready to publish; see fixes.', { details: { fixes: check.fixes, validation: check } });
    }
    const isTechnical = await require('./technical.service').isClientPhone(order.phone, client).catch(() => false);
    // Требования рассылки — из параметров заказчика по связям справочника (requestMatching.service): модератор видит их
    // готовыми в форме рассылки, проверяет и подтверждает; его правки пишутся в журнал.
    const matching = require('./requestMatching.service');
    const prepared = await matching.prepare(order, client);
    const updated = (await client.query(
      `UPDATE orders SET status = 'pending_review', confirmed_at = NOW(), deal_status = 'open', schema_versions = $2::jsonb, is_technical = $3,
         description = $4, target_categories = $5, requirements = $6::jsonb, api_version = api_version + 1, deal_updated_at = NOW()
       WHERE id = $1 AND status = 'unverified' RETURNING *`,
      [order.id, JSON.stringify(check.schema_versions), isTechnical, await describe(order, list, client), prepared.categories, JSON.stringify(prepared.requirements)])).rows[0];
    await matching.log(client, order.id, 'system:request', 'prepared', null, matching.snapshot(updated));
    await consent.applyToOrder(client, account, updated, meta);
    await outbox.emit(client, 'tender.published', order.id, { tender_id: apiId(order), version: updated.api_version }, `tender.published:${order.id}`);
    return updated;
  });
  require('../controllers/order.controller').announceConfirmed(published);
  return { order: published, already: false };
}

// Начало сбора — когда модератор разрешил рассылку (order.service.notifyMasters). Срок — collection_hours (по умолчанию
// 24), но не позже чем за 2 часа до начала работ и не меньше часа. Повторный вызов срок не сдвигает.
async function startCollection(client, orderId, now = new Date()) {
  const order = await lockById(client, orderId);
  if (!order || order.deal_status !== 'open' || order.submission_deadline) return;
  let deadline = now.getTime() + (order.collection_hours || deal.COLLECTION_HOURS.default) * HOUR;
  if (order.requested_start_at) deadline = Math.min(deadline, new Date(order.requested_start_at).getTime() - deal.START_MARGIN_HOURS.collection * HOUR);
  deadline = Math.max(deadline, now.getTime() + HOUR);
  await client.query('UPDATE orders SET submission_deadline = $2, api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1', [orderId, new Date(deadline)]);
}

// Досрочное закрытие сбора заказчиком или по сроку (deal.worker). Событие одно на заявку (dedupe_key).
async function closeCollection(orderId, { actor = 'customer', expected = null, now = new Date() } = {}) {
  return pool.withTransaction(async (client) => {
    const order = await lockById(client, orderId);
    if (!order) throw notFound();
    if (expected !== null) checkVersion(order, expected);
    if (order.deal_status !== 'open' || order.status === 'closed') {
      if (actor === 'worker') return order;
      throw new DealError(409, 'ACTION_NOT_ALLOWED', 'Collection can be closed only while the request is open.');
    }
    if (order.collection_closed_at) return order;
    if (actor !== 'worker' && publication(order) !== 'published') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'The request is still in review; there is nothing to close yet.');
    const at = actor === 'worker' && order.submission_deadline ? new Date(order.submission_deadline) : now;
    const updated = (await client.query('UPDATE orders SET collection_closed_at = $2, api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1 RETURNING *', [orderId, at])).rows[0];
    const count = (await client.query("SELECT COUNT(*)::int AS n FROM offers WHERE order_id=$1 AND status IN ('submitted','selected','accepted')", [orderId])).rows[0].n;
    await outbox.emit(client, 'tender.collection_closed', orderId, { tender_id: apiId(order), active_offer_count: count, actor }, `tender.collection_closed:${orderId}`);
    return updated;
  });
}

async function cancel(orderId, { reason, expected = null, actor = 'client', meta = {} } = {}) {
  const why = text(reason, LIMITS.reason);
  if (!why || why.length < 3 || why.length > LIMITS.reason) throw new DealError(422, 'VALIDATION_FAILED', 'A reason is required.', { fields: [{ path: 'reason', code: 'REQUIRED' }] });
  const order = await pool.withTransaction(async (client) => {
    const current = await lockById(client, orderId);
    if (!current) throw notFound();
    if (expected !== null) checkVersion(current, expected);
    const now = status(current);
    if (['awarded', 'completed'].includes(now)) {
      throw new DealError(409, 'ACTION_NOT_ALLOWED', 'After a provider confirmed the job the request is cancelled through Xtender support.', { details: { support_url: require('../config/url').getBaseUrl() + '/guides/request' } });
    }
    if (now === 'cancelled' || current.status === 'closed') return current;
    await client.query("UPDATE order_selections SET status='cancelled', active_key=NULL, decided_at=NOW() WHERE order_id=$1 AND active_key IS NOT NULL", [orderId]);
    await client.query("UPDATE offers SET status='not_selected', updated_at=NOW() WHERE order_id=$1 AND status IN ('submitted','selected')", [orderId]);
    await client.query("UPDATE orders SET deal_status = 'cancelled', cancel_reason = $2, api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1", [orderId, why]);
    await require('./order.service').finalizeClose(client, current.token, { actor, reason: 'no_longer_needed', meta });
    await outbox.emit(client, 'tender.cancelled', orderId, { tender_id: apiId(current) }, `tender.cancelled:${orderId}`);
    return lockById(client, orderId);
  });
  require('./telegram.service').updateMessage(order).catch(() => {});
  return order;
}

async function complete(orderId, { expected = null, actor = 'client', meta = {} } = {}) {
  const order = await pool.withTransaction(async (client) => {
    const current = await lockById(client, orderId);
    if (!current) throw notFound();
    if (expected !== null) checkVersion(current, expected);
    if (current.deal_status === 'completed') return current;
    if (current.deal_status !== 'awarded') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'Only a request with a confirmed provider can be completed.');
    await client.query("UPDATE orders SET deal_status = 'completed', api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1", [orderId]);
    await require('./order.service').finalizeClose(client, current.token, { actor, reason: 'found_provider', meta });
    await outbox.emit(client, 'tender.completed', orderId, { tender_id: apiId(current) }, `tender.completed:${orderId}`);
    return lockById(client, orderId);
  });
  require('./telegram.service').updateMessage(order).catch(() => {});
  return order;
}

// Способ ответа после публикации можно только расширить: звонки → оба, предложения → оба. Сузить нельзя — исполнители уже
// видели телефон или ждут возможности написать.
async function setResponseMode(orderId, mode, { expected = null } = {}) {
  if (!deal.RESPONSE_MODES.includes(mode)) throw new DealError(422, 'VALIDATION_FAILED', 'response_mode: calls, offers or both.', { fields: [{ path: 'response_mode', code: 'INVALID_OPTION' }] });
  return pool.withTransaction(async (client) => {
    const order = await lockById(client, orderId);
    if (!order) throw notFound();
    if (expected !== null) checkVersion(order, expected);
    if (order.response_mode === mode) return order;
    if (order.status === 'closed') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'The request is closed.');
    if (order.status !== 'unverified' && mode !== 'both') throw new DealError(409, 'ACTION_NOT_ALLOWED', 'After publication the reply mode can only be widened to both.');
    const dealStatus = order.deal_status || (order.status === 'unverified' ? null : 'open');
    await client.query('UPDATE orders SET response_mode = $2, deal_status = $3, api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1', [orderId, mode, dealStatus]);
    let fresh = await lockById(client, orderId);
    // Строка «Ответ: …» в тексте заявки из API — по новому способу. Текст заявки с сайта (свободный текст заказчика) не трогаем.
    if (fresh.original_text || fresh.title) {
      await client.query('UPDATE orders SET description=$2 WHERE id=$1', [orderId, await describe(fresh, await items(orderId, client), client)]);
      fresh = await lockById(client, orderId);
    }
    // Сайт: у прежней заявки сбор начинается с момента, когда заказчик включил предложения (рассылка уже была).
    if (fresh.first_dispatched_at && !fresh.submission_deadline) await startCollection(client, orderId);
    return lockById(client, orderId);
  });
}

// --- Представление ----------------------------------------------------------------------------------------------------
async function view(order, { role, lang = 'en', master = null, client = pool } = {}) {
  const list = await items(order.id, client);
  const now = new Date();
  const city = order.city_id ? (await client.query('SELECT slug FROM cities WHERE id=$1', [order.city_id])).rows[0] : null;
  const district = order.district_id ? (await client.query('SELECT slug FROM districts WHERE id=$1', [order.district_id])).rows[0] : null;
  const selection = (await client.query('SELECT * FROM order_selections WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [order.id])).rows[0] || null;
  const assigned = selection && selection.status === 'accepted' ? selection.master_id : null;
  const owner = role === 'customer';
  const mine = role === 'provider' && master && assigned === master.id;
  const current = status(order, now);
  const counts = (await client.query("SELECT status, COUNT(*)::int AS n FROM offers WHERE order_id=$1 GROUP BY status", [order.id])).rows;
  const activeOffers = counts.filter((c) => ['submitted', 'selected', 'accepted'].includes(c.status)).reduce((a, c) => a + c.n, 0);
  const result = {
    id: apiId(order),
    display_number: String(order.id),
    source: order.channel,
    response_mode: order.response_mode,
    kind: order.kind || 'service',
    title: order.title || null,
    description: order.original_text || order.description,
    original_text: order.original_text || order.client_description || order.description,
    language: order.source_lang || null,
    category_ids: Array.isArray(order.requested_categories) && order.requested_categories.length ? order.requested_categories : (order.target_categories || []).map((c) => (c === 'transport' || c === 'flatbed' ? 'van' : c)),
    location: { country_code: 'GE', city_id: city ? 'city:' + city.slug : null, district_id: district ? 'district:' + district.slug : null,
      public_area_label: order.district_name || null, ...(owner || mine ? { private_address: order.private_address || null } : {}) },
    requested_start_at: deal.iso(order.requested_start_at),
    requested_end_at: deal.iso(order.requested_end_at),
    timezone: order.timezone,
    collection_hours: order.collection_hours || deal.COLLECTION_HOURS.default,
    submission_deadline: deal.iso(order.submission_deadline),
    collection_closed_at: deal.iso(order.collection_closed_at),
    budget: order.budget_max_minor != null && (owner || order.budget_visibility === 'providers')
      ? { currency: order.currency, max_amount_minor: order.budget_max_minor, visibility: order.budget_visibility } : null,
    items: list.map((item) => ({ id: item.id, kind: item.kind, category_id: item.category_id, name: item.name, quantity: item.quantity, unit: item.unit,
      specifications: item.specifications || {}, substitutions_allowed: item.substitutions_allowed, required: item.required })),
    attributes: order.request_attributes || {},
    schema_versions: order.schema_versions || {},
    status: current,
    publication_status: publication(order),
    accepting_offers: acceptsOffers(order, now),
    version: order.api_version,
    created_at: deal.iso(order.created_at),
    updated_at: deal.iso(order.deal_updated_at || order.confirmed_at || order.created_at),
  };
  if (owner) {
    const deliveries = (await client.query('SELECT status FROM dispatch_deliveries WHERE order_id=$1', [order.id])).rows;
    const by = (s) => deliveries.filter((d) => d.status === s).length;
    result.dispatch_summary = { queued: by('pending'), sent: by('accepted'), delivered: null, failed: by('failed'), skipped: by('skipped'),
      providers_with_access: (await client.query('SELECT COUNT(*)::int AS n FROM order_access WHERE order_id=$1', [order.id])).rows[0].n };
    result.active_offer_count = activeOffers;
    result.cancel_reason = order.cancel_reason || null;
    result.customer_page_url = require('../config/url').getBaseUrl() + '/o/' + order.owner_token;
  }
  if (selection && (owner || (role === 'provider' && master && selection.master_id === master.id))) {
    result.selection = { id: selection.id, offer_id: selection.offer_id, offer_version: selection.offer_version, status: selection.status,
      confirm_by: deal.iso(selection.confirm_by), decided_at: deal.iso(selection.decided_at), decline_reason: selection.decline_reason || null };
  }
  // Контакты — только после подтверждённого выбора: исполнителю телефон заказчика, заказчику телефон исполнителя.
  if (mine) result.customer_contact = { phone: require('../config/phone').toE164(order.phone) };
  if (owner && assigned) {
    const provider = (await client.query('SELECT phone FROM masters WHERE id=$1', [assigned])).rows[0];
    if (provider) result.provider_contact = { phone: provider.phone };
  }
  result.allowed_actions = allowedActions(order, role, { current, selection, master, now });
  return result;
}

function allowedActions(order, role, { current, selection, master, now }) {
  const actions = [];
  if (role === 'customer') {
    if (current === 'draft') actions.push('update_tender_draft', 'validate_tender', 'publish_tender', 'cancel_tender');
    if (current === 'open' && publication(order) === 'published') actions.push('close_tender');
    if (['open', 'closed'].includes(current) && ['offers', 'both'].includes(order.response_mode) && publication(order) === 'published') actions.push('select_offer');
    if (['open', 'closed', 'selection_pending'].includes(current)) actions.push('cancel_tender');
    if (current === 'awarded') actions.push('complete_tender');
    if (acceptsMessages(order, now)) actions.push('send_message');
  } else if (role === 'provider') {
    if (acceptsOffers(order, now)) actions.push('create_offer_draft', 'submit_offer');
    if (acceptsMessages(order, now)) actions.push('send_message');
    if (selection && selection.status === 'pending' && master && selection.master_id === master.id) actions.push('accept_selection', 'decline_selection');
  }
  return [...new Set(actions)];
}

async function listForCustomer(account, { status: wanted, q, updatedSince } = {}) {
  const rows = (await pool.query('SELECT * FROM orders WHERE account_id=$1 ORDER BY created_at DESC, id DESC', [account.id])).rows;
  return rows.filter((order) => (!wanted || status(order) === wanted)
    && (!updatedSince || new Date(order.deal_updated_at || order.created_at) >= updatedSince)
    && (!q || `${order.title || ''} ${order.original_text || ''} ${order.id}`.toLowerCase().includes(String(q).toLowerCase())));
}

// Доступные исполнителю заявки (решение 3): только те, куда модератор включил его рассылкой, опубликованные и не закрытые.
async function listForProvider(master, { categoryId, q, startFrom, startTo } = {}) {
  const ids = await access.orderIdsFor(master.id);
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const rows = (await pool.query(`SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'new' ORDER BY created_at DESC, id DESC`, ids)).rows;
  return rows.filter((order) => {
    const cats = [...(order.requested_categories || []), ...(order.target_categories || [])].map((c) => (c === 'transport' || c === 'flatbed' ? 'van' : c));
    return (!categoryId || cats.includes(categoryId))
      && (!q || `${order.title || ''} ${order.description || ''}`.toLowerCase().includes(String(q).toLowerCase()))
      && (!startFrom || (order.requested_start_at && new Date(order.requested_start_at) >= startFrom))
      && (!startTo || (order.requested_start_at && new Date(order.requested_start_at) <= startTo));
  });
}

module.exports = {
  apiId, parseId, status, publication, acceptsOffers, acceptsMessages, collectionClosed, items, lockById, forCustomer, forProvider, forViewer,
  parseInput, createDraft, updateDraft, validate, publish, startCollection, closeCollection, cancel, complete, setResponseMode, view,
  listForCustomer, listForProvider, describe, checkVersion, notFound,
};
