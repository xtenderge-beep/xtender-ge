// Параметры заказчика → требования рассылки (orders.requirements). Связь задана в справочнике: параметр заявки
// (src/config/requestFields.js) ссылается на характеристику исполнителя через maps_to. Требования собирает тот же разбор,
// что у формы модератора (serviceRequirements.parse), поэтому подбор один: предварительный подсчёт (estimate), экран
// модератора и сама рассылка (order.service.getDispatchRecipients / notifyMasters) применяют одни и те же правила.
// Неизвестная характеристика исполнителя требованию не соответствует (serviceRequirements.matches). Число подходящих —
// не обещание, что кто-то свободен. Описание — docs/api-v1/WORKFLOWS.md, раздел «Подбор».
const pool = require('../config/db');
const requestFields = require('../config/requestFields');
const { VAN_SIZE_ORDER } = require('../config/serviceTypes');

const toGroup = (slug) => (slug === 'van' ? 'transport' : slug);
const toSlug = (group) => (group === 'transport' || group === 'flatbed' ? 'van' : group);

// Значение параметра заказчика → значение поля формы модератора для характеристики target (строки, как в форме).
// Возвращает { value } или { skip: код причины }; note — пометка модератору.
function formValue(target, value) {
  if (target.input === 'bool') return value === true ? { value: 'on' } : { skip: 'NOT_REQUIRED' };
  if (target.input === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? { value: String(n) } : { skip: 'TYPE_MISMATCH' };
  }
  if (target.input === 'enum') {
    const options = (target.options || []).map(String);
    if (options.includes(String(value))) return { value: String(value) };
    // Число против списка числовых классов (тоннаж эвакуатора 3.5 / 8 / 20, объём кузова 2 / 4 / 8 / 15): «не меньше» —
    // наименьший класс, который точно покрывает требование. Больше самого крупного — самый крупный, с пометкой модератору.
    const n = Number(value);
    const numeric = options.map(Number);
    if (!Number.isFinite(n) || !numeric.length || !numeric.every(Number.isFinite)) return { skip: 'NO_MATCHING_OPTION' };
    if (target.match === 'gte') {
      const index = numeric.findIndex((option) => option >= n);
      return index >= 0 ? { value: options[index] } : { value: options[options.length - 1], note: 'ABOVE_LARGEST_OPTION' };
    }
    const exact = options.find((option, i) => numeric[i] === n);
    return exact ? { value: exact } : { skip: 'NO_MATCHING_OPTION' };
  }
  return { skip: 'TYPE_MISMATCH' };
}

// Требования рассылки для заявки. Ничего не пишет. notes — что не удалось перенести и почему (видит модератор).
async function prepare(order, client = pool) {
  const rows = await require('./category.service').list(client);
  const json = (value, fallback) => (typeof value === 'string' ? JSON.parse(value) : value ?? fallback);
  const requested = json(order.requested_categories, []);
  const attributes = json(order.request_attributes, {});
  const categories = [];
  const submitted = {};
  const notes = [];
  let sizes = [];
  for (const slug of requested) {
    const row = rows.find((r) => r.slug === slug && r.is_active);
    if (!row) continue;
    const group = toGroup(slug);
    if (!categories.includes(group)) categories.push(group);
    submitted[group] = submitted[group] || {};
    const fields = requestFields.forCategory(row);
    for (const [key, value] of Object.entries(attributes[slug] || {})) {
      const field = fields.find((f) => f.key === key);
      if (!field?.maps_to) continue;
      const target = (row.fields || []).find((f) => f.key === field.maps_to.field);
      if (!target) { notes.push({ category_id: slug, parameter: key, code: 'TARGET_MISSING' }); continue; }
      // Класс кузова (S…XXL) — особое поле: подбор по списку подходящих классов (transport_sizes).
      if (target.input === 'size') {
        const index = VAN_SIZE_ORDER.indexOf(String(value));
        if (index < 0) { notes.push({ category_id: slug, parameter: key, code: 'NO_MATCHING_OPTION' }); continue; }
        sizes = field.maps_to.rule === 'provider_eq' ? [VAN_SIZE_ORDER[index]] : VAN_SIZE_ORDER.slice(index);
        continue;
      }
      if (!['exact', 'gte', 'flag'].includes(target.match)) { notes.push({ category_id: slug, parameter: key, code: 'TARGET_NOT_MATCHED' }); continue; }
      const converted = formValue(target, value);
      if (converted.skip) { if (converted.skip !== 'NOT_REQUIRED') notes.push({ category_id: slug, parameter: key, code: converted.skip }); continue; }
      submitted[group][target.key] = converted.value;
      if (converted.note) notes.push({ category_id: slug, parameter: key, code: converted.note, value: converted.value });
    }
  }
  const details = require('./serviceRequirements.service').parse(rows, categories, submitted);
  const requirements = { ...require('./orderNeeds.service').requirementsOf(categories.includes('transport') ? sizes : [], details),
    prepared: { source: 'request', notes } };
  return { categories, requirements, notes };
}

// Сколько исполнителей подходят сейчас — той же функцией, что выбирает получателей рассылки (с учётом города, активности,
// услуги, характеристик и того, можно ли им сейчас отправить заявку). Не обещание, что кто-то свободен или ответит.
async function estimate(order, client = pool) {
  const { categories, requirements } = await prepare(order, client);
  const virtual = { ...order, status: 'pending_review', target_categories: categories, requirements };
  const price = await require('./settings.service').getLeadPriceTetri();
  const orders = require('./order.service');
  const ids = new Set();
  const byCategory = {};
  for (const group of categories) {
    const recipients = await orders.getDispatchRecipients(group, '', price, order.is_technical === true, '', virtual);
    byCategory[toSlug(group)] = recipients.length;
    recipients.forEach((master) => ids.add(master.id));
  }
  return { matching_providers: ids.size, by_category: byCategory, checked_at: new Date().toISOString(),
    note: 'Providers whose confirmed characteristics and city fit the request now. Not a promise that anyone is free, will answer or will make an offer.' };
}

// Журнал требований: подготовлены из параметров заказчика (prepared) и каждое ручное изменение модератора (changed).
function snapshot(order) {
  return { target_categories: Array.isArray(order.target_categories) ? order.target_categories : [], requirements: order.requirements || null, city_id: order.city_id || null };
}

async function log(client, orderId, actor, action, before, after) {
  await client.query('INSERT INTO order_requirement_events (order_id, actor, action, before_value, after_value) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)',
    [orderId, String(actor || 'unknown').slice(0, 120), action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function events(orderId, client = pool) {
  return (await client.query('SELECT * FROM order_requirement_events WHERE order_id=$1 ORDER BY id', [orderId])).rows;
}

module.exports = { prepare, estimate, formValue, snapshot, log, events, toGroup, toSlug };
