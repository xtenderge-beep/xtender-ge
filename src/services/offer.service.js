// Предложения исполнителей (ТЗ, раздел 6; docs/api-v1/WORKFLOWS.md). Одно предложение исполнителя на заявку; правка
// после отправки — новая версия (offer_versions) и событие offer.updated. Суммы считает сервер: неизвестная стоимость не
// превращается в ноль — итог тогда null (total_status = incomplete) с причинами, а known_amount_minor — сумма известного.
// Формула: строки − скидка + налог сверху (если не включён) + отдельная доставка + отдельная разгрузка + доп. расходы.
const crypto = require('node:crypto');
const pool = require('../config/db');
const deal = require('../config/deal');
const tenders = require('./tender.service');
const outbox = require('./outbox.service');
const access = require('./orderAccess.service');
const phoneInText = require('../config/phoneInText');

const { DealError, LIMITS, HOUR } = deal;
const PRICING = ['fixed', 'estimate', 'on_inspection'];
const CHARGE_STATES = ['included', 'separate', 'not_provided', 'unknown', 'not_applicable'];
const TAX_STATES = ['included', 'excluded', 'unknown'];
const ACTIVE = ['submitted', 'selected', 'accepted'];
const newId = () => 'ofr_' + crypto.randomBytes(10).toString('hex');
const notFound = () => new DealError(404, 'NOT_FOUND', 'The offer does not exist or is not accessible to this account.');

// Свободный текст исполнителя: без управляющих символов; номера телефонов скрыты, как в описании профиля (телефон
// открывается после выбора, а не текстом предложения).
function clean(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
  if (text.length > max) return undefined;
  return text ? phoneInText.maskPhones(text) : null;
}

function cleanList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.list) return undefined;
  const out = value.map((v) => clean(v, LIMITS.listItem));
  return out.some((v) => v === undefined) ? undefined : out.filter(Boolean);
}

const money = (v) => (v === undefined || v === null ? null : deal.isMinor(v) ? v : undefined);
const date = (v) => (v === undefined || v === null || v === '' ? null : Number.isNaN(Date.parse(v)) ? undefined : new Date(v).toISOString());

// Доставка и разгрузка нужны, если заявка — товары или смешанная, или в ней есть такие позиции.
function needs(order, list) {
  const goods = ['goods', 'mixed'].includes(order.kind);
  return { delivery: goods || list.some((i) => i.kind === 'delivery'), unloading: list.some((i) => i.kind === 'unloading'),
    deliveryRequired: list.some((i) => i.kind === 'delivery' && i.required), unloadingRequired: list.some((i) => i.kind === 'unloading' && i.required) };
}

// Проверка и нормализация условий. Возвращает data для хранения (без сумм) или бросает 422 с полями.
function parseTerms(raw, order, list) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DealError(400, 'INVALID_REQUEST', 'Send a JSON object.');
  const fields = [];
  const need = needs(order, list);
  const data = { currency: 'GEL' };
  if (raw.currency !== undefined && raw.currency !== 'GEL') fields.push({ path: 'currency', code: 'UNSUPPORTED_CURRENCY' });
  data.pricing_type = raw.pricing_type === undefined ? 'fixed' : raw.pricing_type;
  if (!PRICING.includes(data.pricing_type)) fields.push({ path: 'pricing_type', code: 'INVALID_OPTION' });
  const lines = raw.line_items === undefined ? [] : raw.line_items;
  if (!Array.isArray(lines) || lines.length > LIMITS.items) fields.push({ path: 'line_items', code: 'INVALID_VALUE' });
  data.line_items = (Array.isArray(lines) ? lines : []).map((line, i) => {
    const at = `line_items[${i}]`;
    if (!line || typeof line !== 'object') { fields.push({ path: at, code: 'INVALID_VALUE' }); return null; }
    const item = line.tender_item_id ? list.find((it) => it.id === line.tender_item_id) : null;
    if (line.tender_item_id && !item) fields.push({ path: `${at}.tender_item_id`, code: 'UNKNOWN_ITEM' });
    const name = clean(line.offered_name ?? line.name, LIMITS.itemName);
    if (!name) fields.push({ path: `${at}.offered_name`, code: 'REQUIRED' });
    const quantity = line.quantity === undefined || line.quantity === null || line.quantity === '' ? null : String(line.quantity).trim();
    if (quantity !== null && !/^\d{1,9}(\.\d{1,3})?$/.test(quantity)) fields.push({ path: `${at}.quantity`, code: 'INVALID_DECIMAL' });
    const unitPrice = money(line.unit_price_minor);
    const lineTotal = money(line.line_total_minor);
    if (unitPrice === undefined) fields.push({ path: `${at}.unit_price_minor`, code: 'INVALID_MONEY' });
    if (lineTotal === undefined) fields.push({ path: `${at}.line_total_minor`, code: 'INVALID_MONEY' });
    const substitution = line.is_substitution === true;
    // Замена — только явно и только там, где заказчик её разрешил.
    if (substitution && item && !item.substitutions_allowed) fields.push({ path: `${at}.is_substitution`, code: 'SUBSTITUTION_NOT_ALLOWED' });
    const deviation = clean(line.deviation_description, LIMITS.listItem);
    if (substitution && !deviation) fields.push({ path: `${at}.deviation_description`, code: 'REQUIRED_FOR_SUBSTITUTION' });
    return { tender_item_id: item ? item.id : null, offered_name: name, brand: clean(line.brand, 80) || null, model: clean(line.model, 80) || null,
      specifications: line.specifications && typeof line.specifications === 'object' && !Array.isArray(line.specifications) ? line.specifications : {},
      quantity, unit: line.unit ? require('../config/units').codeFor(String(line.unit)) : (item?.unit || null),
      unit_price_minor: unitPrice ?? null, line_total_minor: lineTotal ?? null, is_substitution: substitution, deviation_description: deviation || null };
  }).filter(Boolean);
  if (!data.line_items.length) fields.push({ path: 'line_items', code: 'REQUIRED', hint: 'At least one line: the work or the goods with a price (or null if the price is unknown).' });
  data.discount_minor = money(raw.discount_minor);
  if (data.discount_minor === undefined) fields.push({ path: 'discount_minor', code: 'INVALID_MONEY' });
  const charge = (key, relevant) => {
    const value = raw[key];
    const state = value?.state || (relevant ? 'unknown' : 'not_applicable');
    if (!CHARGE_STATES.includes(state)) { fields.push({ path: `${key}.state`, code: 'INVALID_OPTION' }); return { state: 'unknown', amount_minor: null }; }
    const amount = money(value?.amount_minor);
    if (amount === undefined) fields.push({ path: `${key}.amount_minor`, code: 'INVALID_MONEY' });
    return { state, amount_minor: state === 'included' ? 0 : state === 'separate' ? amount ?? null : null };
  };
  data.delivery = charge('delivery', need.delivery);
  data.unloading = charge('unloading', need.unloading);
  const taxState = raw.tax?.state || 'included';
  if (!TAX_STATES.includes(taxState)) fields.push({ path: 'tax.state', code: 'INVALID_OPTION' });
  const taxAmount = money(raw.tax?.amount_minor);
  if (taxAmount === undefined) fields.push({ path: 'tax.amount_minor', code: 'INVALID_MONEY' });
  data.tax = { state: TAX_STATES.includes(taxState) ? taxState : 'unknown', amount_minor: taxState === 'excluded' ? taxAmount ?? null : taxState === 'included' ? 0 : null };
  const extra = raw.additional_costs === undefined || raw.additional_costs === null ? [] : raw.additional_costs;
  if (!Array.isArray(extra) || extra.length > LIMITS.list) fields.push({ path: 'additional_costs', code: 'INVALID_VALUE' });
  data.additional_costs = (Array.isArray(extra) ? extra : []).map((cost, i) => {
    const name = clean(cost?.name, 120);
    const amount = money(cost?.amount_minor);
    if (!name) fields.push({ path: `additional_costs[${i}].name`, code: 'REQUIRED' });
    if (amount === undefined) fields.push({ path: `additional_costs[${i}].amount_minor`, code: 'INVALID_MONEY' });
    return { name, amount_minor: amount ?? null };
  });
  for (const key of ['start_at', 'completion_at', 'valid_until']) {
    data[key] = date(raw[key]);
    if (data[key] === undefined) fields.push({ path: key, code: 'INVALID_DATE' });
  }
  if (data.start_at && data.completion_at && data.completion_at < data.start_at) fields.push({ path: 'completion_at', code: 'BEFORE_START' });
  const pt = raw.payment_terms || {};
  data.payment_terms = { deposit_amount_minor: money(pt.deposit_amount_minor) ?? null,
    deposit_percent: pt.deposit_percent === undefined || pt.deposit_percent === null ? null : Number(pt.deposit_percent),
    balance_due: clean(pt.balance_due, 200) || null,
    methods: Array.isArray(pt.methods) ? pt.methods.filter((m) => ['cash', 'bank_transfer', 'card'].includes(m)) : [],
    text: clean(pt.text, LIMITS.note) || null };
  if (money(pt.deposit_amount_minor) === undefined) fields.push({ path: 'payment_terms.deposit_amount_minor', code: 'INVALID_MONEY' });
  if (data.payment_terms.deposit_percent !== null && !(data.payment_terms.deposit_percent >= 0 && data.payment_terms.deposit_percent <= 100)) fields.push({ path: 'payment_terms.deposit_percent', code: 'OUT_OF_RANGE' });
  for (const [key, max] of [['warranty', 300], ['notes', LIMITS.note]]) {
    data[key] = clean(raw[key], max);
    if (data[key] === undefined) fields.push({ path: key, code: 'INVALID_VALUE' });
  }
  for (const key of ['exclusions', 'assumptions']) {
    data[key] = cleanList(raw[key]);
    if (data[key] === undefined) fields.push({ path: key, code: 'INVALID_VALUE' });
  }
  if (fields.length) throw new DealError(422, 'VALIDATION_FAILED', 'Some offer fields are invalid.', { fields });
  return data;
}

// Суммы и полнота. Возвращает поля, которые добавляются к data при сохранении версии.
function totals(data, order, list) {
  const reasons = [];
  const deviations = [];
  const need = needs(order, list);
  let known = 0;
  let subtotal = 0;
  let linesKnown = true;
  for (const line of data.line_items) {
    const total = line.line_total_minor ?? (line.unit_price_minor != null && line.quantity != null ? Math.round(line.unit_price_minor * Number(line.quantity)) : null);
    line.computed_total_minor = total;
    if (total === null) linesKnown = false; else { subtotal += total; known += total; }
    if (line.is_substitution) deviations.push({ path: `line_items.${line.tender_item_id || line.offered_name}`, type: 'substitution', description: line.deviation_description });
  }
  if (!linesKnown) reasons.push('line_price_unknown');
  if (data.pricing_type === 'on_inspection') reasons.push('price_after_inspection');
  const discount = data.discount_minor || 0;
  known -= discount;
  if (data.tax.state === 'unknown') reasons.push('tax_unknown');
  else if (data.tax.state === 'excluded') { if (data.tax.amount_minor === null) reasons.push('tax_amount_unknown'); else known += data.tax.amount_minor; }
  for (const key of ['delivery', 'unloading']) {
    const c = data[key];
    const required = key === 'delivery' ? need.deliveryRequired : need.unloadingRequired;
    if (c.state === 'unknown') reasons.push(`${key}_unknown`);
    else if (c.state === 'separate') { if (c.amount_minor === null) reasons.push(`${key}_amount_unknown`); else known += c.amount_minor; }
    else if (c.state === 'not_provided' && required) { reasons.push(`${key}_not_provided`); deviations.push({ path: key, type: 'not_provided', description: `${key} is required by the request but not provided` }); }
  }
  for (const cost of data.additional_costs) { if (cost.amount_minor === null) reasons.push('additional_cost_unknown'); else known += cost.amount_minor; }
  // Покрытие обязательных позиций заявки (MVP: одно предложение на всю заявку, ТЗ раздел 6).
  const covered = new Set(data.line_items.map((l) => l.tender_item_id).filter(Boolean));
  const missingItems = list.filter((i) => i.required && ['goods', 'service'].includes(i.kind) && !covered.has(i.id)).map((i) => i.id);
  if (list.some((i) => i.kind === 'goods') && missingItems.length) reasons.push('required_item_missing');
  const complete = !reasons.length;
  return {
    subtotal_minor: linesKnown ? subtotal : null,
    discount_minor: data.discount_minor ?? null,
    tax_minor: data.tax.state === 'excluded' ? data.tax.amount_minor : data.tax.state === 'included' ? 0 : null,
    delivery_minor: data.delivery.state === 'separate' ? data.delivery.amount_minor : data.delivery.state === 'included' ? 0 : null,
    unloading_minor: data.unloading.state === 'separate' ? data.unloading.amount_minor : data.unloading.state === 'included' ? 0 : null,
    total_amount_minor: complete ? known : null,
    known_amount_minor: Math.max(0, known),
    total_status: complete ? 'complete' : 'incomplete',
    incomplete_reasons: [...new Set(reasons)],
    missing_items: missingItems,
    deviations,
  };
}

async function lock(client, offerId) {
  return (await client.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE', [offerId])).rows[0] || null;
}

function checkVersion(offer, expected) {
  if (expected !== null && expected !== undefined && String(offer.version) !== String(expected)) {
    throw new DealError(412, 'VERSION_MISMATCH', 'The offer has changed since you read it. Read it again.', { details: { current_version: offer.version } });
  }
}

// Может ли исполнитель сейчас отправлять или править предложение к этой заявке.
async function assertCanOffer(client, order, master) {
  if (!master || master.is_banned || !master.is_active) throw new DealError(403, 'PROVIDER_NOT_ACTIVE', 'Only an active provider can send offers.');
  if (!(await access.has(order.id, master.id, client))) throw tenders.notFound();
  if (require('../config/phone').toE164(order.phone) === require('../config/phone').toE164(master.phone)) {
    throw new DealError(403, 'OWN_REQUEST', 'A provider cannot answer their own request.');
  }
  if (!['offers', 'both'].includes(order.response_mode)) throw new DealError(409, 'OFFERS_NOT_ACCEPTED', 'The customer asked for calls, not written offers.');
  if (tenders.publication(order) !== 'published') throw new DealError(409, 'IN_REVIEW', 'The request is still in moderator review.');
  if (!tenders.acceptsOffers(order)) {
    throw new DealError(409, 'COLLECTION_CLOSED', 'The request no longer accepts offers (deadline passed, collection closed or a provider chosen).',
      { details: { submission_deadline: deal.iso(order.submission_deadline) } });
  }
}

function defaultValidUntil(order) {
  const base = Math.max(Date.now(), order.submission_deadline ? new Date(order.submission_deadline).getTime() : 0);
  return new Date(base + deal.OFFER_VALID_DEFAULT_HOURS * HOUR).toISOString();
}

async function saveVersion(client, offer, data) {
  await client.query('INSERT INTO offer_versions (offer_id, version, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [offer.id, offer.version, JSON.stringify(data)]);
}

// Черновик предложения (API). Если у исполнителя уже есть предложение к заявке — 409 с его id: одно на заявку.
async function createDraft(master, tenderId, raw) {
  const order = await tenders.forProvider(master, tenderId);
  return pool.withTransaction(async (client) => {
    const live = await tenders.lockById(client, order.id);
    await assertCanOffer(client, live, master);
    const list = await tenders.items(live.id, client);
    const data = parseTerms(raw, live, list);
    const existing = (await client.query('SELECT * FROM offers WHERE order_id=$1 AND master_id=$2 FOR UPDATE', [live.id, master.id])).rows[0];
    if (existing && !['withdrawn', 'expired', 'declined', 'not_selected'].includes(existing.status)) {
      throw new DealError(409, 'OFFER_EXISTS', 'You already have an offer for this request; update it instead.', { details: { offer_id: existing.id } });
    }
    const full = { ...data, ...totals(data, live, list), valid_until: data.valid_until || defaultValidUntil(live) };
    if (existing) {
      return (await client.query("UPDATE offers SET status='draft', data=$2::jsonb, version=version+1, valid_until=$3, updated_at=NOW() WHERE id=$1 RETURNING *",
        [existing.id, JSON.stringify(full), full.valid_until])).rows[0];
    }
    return (await client.query('INSERT INTO offers (id, order_id, master_id, status, data, valid_until) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *',
      [newId(), live.id, master.id, 'draft', JSON.stringify(full), full.valid_until])).rows[0];
  });
}

// Правка своего невыбранного предложения. Отправленное — новая версия и событие offer.updated; после срока или выбора — 409.
async function update(master, offerId, expected, raw) {
  return pool.withTransaction(async (client) => {
    const offer = await lock(client, offerId);
    if (!offer || offer.master_id !== master.id) throw notFound();
    checkVersion(offer, expected);
    if (!['draft', 'submitted'].includes(offer.status)) throw new DealError(409, 'ACTION_NOT_ALLOWED', `An offer in status ${offer.status} cannot be changed.`);
    const order = await tenders.lockById(client, offer.order_id);
    if (offer.status === 'submitted') await assertCanOffer(client, order, master);
    const list = await tenders.items(order.id, client);
    const data = parseTerms(raw, order, list);
    const full = { ...data, ...totals(data, order, list), valid_until: data.valid_until || offer.valid_until?.toISOString?.() || defaultValidUntil(order) };
    const updated = (await client.query('UPDATE offers SET data=$2::jsonb, version=version+1, valid_until=$3, tender_version=$4, updated_at=NOW() WHERE id=$1 RETURNING *',
      [offer.id, JSON.stringify(full), full.valid_until, order.api_version])).rows[0];
    if (offer.status === 'submitted') {
      await saveVersion(client, updated, full);
      await outbox.emit(client, 'offer.updated', order.id, { offer_id: offer.id, offer_version: updated.version, tender_id: tenders.apiId(order) });
    }
    return updated;
  });
}

// Отправка заказчику. Проверяет срок сам (не ждёт фонового закрытия сбора). first — первое предложение от уникального
// исполнителя по заявке: по нему одна SMS заказчику (порог считается по исполнителям, правка цены его не меняет).
async function submit(master, offerId, expected) {
  return pool.withTransaction(async (client) => {
    const offer = await lock(client, offerId);
    if (!offer || offer.master_id !== master.id) throw notFound();
    checkVersion(offer, expected);
    if (offer.status === 'submitted') return offer;
    if (!['draft', 'withdrawn', 'expired'].includes(offer.status)) throw new DealError(409, 'ACTION_NOT_ALLOWED', `An offer in status ${offer.status} cannot be submitted.`);
    const order = await tenders.lockById(client, offer.order_id);
    await assertCanOffer(client, order, master);
    const list = await tenders.items(order.id, client);
    const data = parseTerms(offer.data, order, list);
    const full = { ...data, ...totals(data, order, list), valid_until: offer.data.valid_until || defaultValidUntil(order) };
    if (new Date(full.valid_until) <= new Date()) throw new DealError(422, 'VALIDATION_FAILED', 'valid_until must be in the future.', { fields: [{ path: 'valid_until', code: 'IN_THE_PAST' }] });
    const before = (await client.query("SELECT COUNT(*)::int AS n FROM offers WHERE order_id=$1 AND submitted_at IS NOT NULL AND id <> $2", [order.id, offer.id])).rows[0].n;
    const updated = (await client.query(
      "UPDATE offers SET status='submitted', data=$2::jsonb, version=version+1, valid_until=$3, tender_version=$4, submitted_at=COALESCE(submitted_at, NOW()), updated_at=NOW() WHERE id=$1 RETURNING *",
      [offer.id, JSON.stringify(full), full.valid_until, order.api_version])).rows[0];
    await saveVersion(client, updated, full);
    await client.query('UPDATE orders SET api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1', [order.id]);
    await outbox.emit(client, 'offer.submitted', order.id, { offer_id: offer.id, offer_version: updated.version, tender_id: tenders.apiId(order), first: before === 0 && !offer.submitted_at },
      `offer.submitted:${offer.id}:${updated.version}`);
    return updated;
  });
}

// Сайт: форма отправляет предложение одним шагом — создать или обновить и отправить.
async function saveAndSubmit(master, order, raw) {
  const existing = (await pool.query('SELECT * FROM offers WHERE order_id=$1 AND master_id=$2', [order.id, master.id])).rows[0];
  if (existing && existing.status === 'submitted') return update(master, existing.id, existing.version, raw);
  const draft = existing && existing.status === 'draft'
    ? await update(master, existing.id, existing.version, raw)
    : await createDraft(master, tenders.apiId(order), raw);
  return submit(master, draft.id, draft.version);
}

async function withdraw(master, offerId, expected) {
  return pool.withTransaction(async (client) => {
    const offer = await lock(client, offerId);
    if (!offer || offer.master_id !== master.id) throw notFound();
    checkVersion(offer, expected);
    if (offer.status === 'withdrawn') return offer;
    if (!['draft', 'submitted'].includes(offer.status)) throw new DealError(409, 'ACTION_NOT_ALLOWED', offer.status === 'selected'
      ? 'The customer chose this offer: decline the selection instead.' : `An offer in status ${offer.status} cannot be withdrawn.`);
    const updated = (await client.query("UPDATE offers SET status='withdrawn', version=version+1, updated_at=NOW() WHERE id=$1 RETURNING *", [offer.id])).rows[0];
    await client.query('UPDATE orders SET api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1', [offer.order_id]);
    await outbox.emit(client, 'offer.withdrawn', offer.order_id, { offer_id: offer.id, offer_version: updated.version });
    return updated;
  });
}

async function expireDue(now = new Date()) {
  const due = (await pool.query("SELECT id, order_id FROM offers WHERE status='submitted' AND valid_until IS NOT NULL AND valid_until <= $1", [now])).rows;
  for (const row of due) {
    await pool.withTransaction(async (client) => {
      const offer = await lock(client, row.id);
      if (!offer || offer.status !== 'submitted' || new Date(offer.valid_until) > now) return;
      await client.query("UPDATE offers SET status='expired', version=version+1, updated_at=NOW() WHERE id=$1", [offer.id]);
      await client.query('UPDATE orders SET api_version = api_version + 1, deal_updated_at = NOW() WHERE id = $1', [offer.order_id]);
      await outbox.emit(client, 'offer.expired', offer.order_id, { offer_id: offer.id }, `offer.expired:${offer.id}:${offer.version}`);
    });
  }
  return due.length;
}

// --- Чтение ----------------------------------------------------------------------------------------------------------
async function forViewer(viewer, offerId) {
  const offer = (await pool.query('SELECT * FROM offers WHERE id=$1', [String(offerId || '')])).rows[0];
  if (!offer) throw notFound();
  if (viewer.master && offer.master_id === viewer.master.id) return { offer, role: 'provider' };
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [offer.order_id])).rows[0];
  if (viewer.account && order && order.account_id === viewer.account.id && offer.status !== 'draft') return { offer, role: 'customer', order };
  throw notFound();
}

async function providerInfo(masterId, client = pool) {
  const master = (await client.query('SELECT id, name, display_name_override, spoken_languages FROM masters WHERE id=$1', [masterId])).rows[0];
  const reviews = (await client.query('SELECT rating FROM master_reviews WHERE master_id=$1 AND is_approved=true', [masterId])).rows.map((r) => Number(r.rating));
  return { id: 'prv_' + masterId, display_name: master ? require('../config/providerName').resolve(master) : null,
    languages: master?.spoken_languages || [], rating: reviews.length ? Math.round((reviews.reduce((a, b) => a + b, 0) / reviews.length) * 100) / 100 : null,
    review_count: reviews.length };
}

async function view(offer, { withVersions = false, client = pool } = {}) {
  const order = (await client.query('SELECT id, api_version FROM orders WHERE id=$1', [offer.order_id])).rows[0];
  const d = offer.data || {};
  const result = {
    id: offer.id, tender_id: 'tnd_' + offer.order_id, provider_id: 'prv_' + offer.master_id, status: offer.status, version: offer.version,
    tender_version: offer.tender_version, current_tender_version: order?.api_version ?? null,
    currency: d.currency || 'GEL', pricing_type: d.pricing_type,
    line_items: (d.line_items || []).map(({ computed_total_minor, ...line }) => ({ ...line, line_total_minor: line.line_total_minor ?? computed_total_minor ?? null })),
    subtotal_minor: d.subtotal_minor ?? null, discount_minor: d.discount_minor ?? null, tax: d.tax || null, tax_minor: d.tax_minor ?? null,
    delivery: d.delivery || null, unloading: d.unloading || null, additional_costs: d.additional_costs || [],
    total_amount_minor: d.total_amount_minor ?? null, known_amount_minor: d.known_amount_minor ?? null, total_status: d.total_status || 'incomplete',
    incomplete_reasons: d.incomplete_reasons || [], missing_items: d.missing_items || [], deviations: d.deviations || [],
    start_at: d.start_at || null, completion_at: d.completion_at || null, valid_until: deal.iso(offer.valid_until), payment_terms: d.payment_terms || null,
    warranty: d.warranty || null, exclusions: d.exclusions || [], assumptions: d.assumptions || [], notes: d.notes || null, attachments: [],
    provider: await providerInfo(offer.master_id, client),
    submitted_at: deal.iso(offer.submitted_at), created_at: deal.iso(offer.created_at), updated_at: deal.iso(offer.updated_at),
  };
  if (withVersions) {
    result.history = (await client.query('SELECT version, data, created_at FROM offer_versions WHERE offer_id=$1 ORDER BY version', [offer.id])).rows
      .map((v) => ({ version: v.version, total_amount_minor: v.data.total_amount_minor ?? null, known_amount_minor: v.data.known_amount_minor ?? null,
        total_status: v.data.total_status, pricing_type: v.data.pricing_type, start_at: v.data.start_at || null, completion_at: v.data.completion_at || null,
        saved_at: deal.iso(v.created_at) }));
  }
  return result;
}

async function listForOrder(orderId, { includeInactive = false, client = pool } = {}) {
  const rows = (await client.query("SELECT * FROM offers WHERE order_id=$1 AND status <> 'draft' ORDER BY submitted_at, id", [orderId])).rows;
  return includeInactive ? rows : rows.filter((o) => ACTIVE.includes(o.status));
}

async function listForMaster(masterId, { tenderId, status } = {}) {
  const orderId = tenderId ? tenders.parseId(tenderId) : null;
  const rows = (await pool.query('SELECT * FROM offers WHERE master_id=$1 ORDER BY updated_at DESC, id', [masterId])).rows;
  return rows.filter((o) => (!orderId || o.order_id === orderId) && (!status || o.status === status));
}

async function mine(orderId, masterId) {
  return (await pool.query('SELECT * FROM offers WHERE order_id=$1 AND master_id=$2', [orderId, masterId])).rows[0] || null;
}

module.exports = {
  PRICING, CHARGE_STATES, TAX_STATES, ACTIVE, parseTerms, totals, createDraft, update, submit, saveAndSubmit, withdraw, expireDue,
  forViewer, view, listForOrder, listForMaster, mine, lock, providerInfo, checkVersion, needs,
};
