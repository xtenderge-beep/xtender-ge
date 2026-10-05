const pool = require('../config/db');
const categoryService = require('./category.service');
const orderService = require('./order.service');
const { VAN_SIZE_ORDER } = require('../config/serviceTypes');
const requirementsService = require('./serviceRequirements.service');
const { needSizes } = require('./serviceMatching.service');

const INVALID = 'Выберите потребности и корректный размер транспорта';

// Классы кузова из формы: один (прежние формы) или несколько (экран менеджера), по возрастанию.
function parseSizes(rawSize, categories) {
  const sizes = [...new Set([].concat(rawSize || []).filter(value => value !== ''))];
  if (sizes.some(size => !VAN_SIZE_ORDER.includes(size)) || (sizes.length && !categories.includes('transport'))) throw new Error(INVALID);
  return VAN_SIZE_ORDER.filter(size => sizes.includes(size));
}

// transport_sizes — все подходящие классы; transport_size остаётся для прежних читателей, когда класс один.
const requirementsOf = (sizes, details) => ({ configured: true, transport_size: sizes.length === 1 ? sizes[0] : '', transport_sizes: sizes, ...details });

async function cityFor(order, rawCityId) {
  const cities = await require('./master.service').getActiveCities();
  const cityId = rawCityId == null || rawCityId === '' ? null : Number(rawCityId);
  if (cityId !== null && (!Number.isSafeInteger(cityId) || !cities.some(city => city.id === cityId))) throw new Error('Выберите доступный город заявки');
  const selected = cityId || order.city_id || cities.find(city => city.slug === 'tbilisi')?.id;
  if (!selected) throw new Error('Город заявки не найден');
  return selected;
}

async function save(token, rawCategories, rawSize, rawAttributes, rawCityId) {
  const categories = [...new Set([].concat(rawCategories || []))];
  const groups = await categoryService.groups();
  if (!categories.length || categories.some(key => typeof key !== 'string' || !Object.hasOwn(groups,key))) throw new Error(INVALID);
  const sizes = parseSizes(rawSize, categories);
  const details = requirementsService.parse(await categoryService.list(),categories,rawAttributes || {});
  await pool.withTransaction(async client => {
    const order = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE',[token])).rows[0];
    if (!order || order.first_dispatched_at || order.status !== 'pending_review') throw new Error('Потребности можно настроить до первой рассылки. После неё можно закрывать отдельные потребности.');
    await client.query('UPDATE orders SET target_categories=$2,requirements=$3::jsonb,city_id=$4,revision_version=revision_version+1 WHERE token=$1',
      [token,categories,JSON.stringify(requirementsOf(sizes,details)),await cityFor(order,rawCityId)]);
  });
  const order = await orderService.getOrderByToken(token);
  await require('./telegram.service').updateMessage(order);
  return order;
}

// Потребности заявки, какими они станут после сохранения формы менеджера (ничего не пишет).
// До первой рассылки форма задаёт всё. После неё заявку можно только расширять: исполнитель,
// который уже получил и оплатил заявку, должен и дальше ей подходить — от этого зависит его
// доступ к контакту заказчика (orderContact.service). Поэтому разосланные услуги и их требования
// не меняются; к разосланным классам кузова можно добавить другие или снять ограничение по
// размеру; новые услуги можно добавить, а ещё не разосланные — изменить или убрать.
// input: needs, needAttributes, transportSize (классы), transportAny (любой размер), cityId.
async function draft(order, input = {}, client = pool) {
  const groups = await categoryService.groups();
  const submitted = [...new Set([].concat(input.needs || []))];
  if (submitted.some(key => typeof key !== 'string' || !Object.hasOwn(groups, key))) throw new Error(INVALID);
  const sent = (await client.query('SELECT category, vehicle_size FROM order_dispatches WHERE order_id=$1', [order.id])).rows;
  const stored = order.requirements?.configured ? order.requirements : null;
  const locked = [...new Set(sent.map(row => row.category))];
  const all = [...new Set([...locked, ...submitted])];
  const categories = [...Object.keys(groups).filter(key => all.includes(key)), ...all.filter(key => !Object.hasOwn(groups, key))];
  const free = categories.filter(key => !locked.includes(key));
  const parsed = requirementsService.parse(await categoryService.list(client), free, input.needAttributes || {});
  const details = { services: { ...parsed.services }, rules: { ...parsed.rules } };
  for (const key of locked) { details.services[key] = stored?.services?.[key] || {}; details.rules[key] = stored?.rules?.[key] || []; }
  const chosen = input.transportAny ? [] : parseSizes(input.transportSize, categories);
  let sizes = chosen, sentSizes = [];
  if (locked.includes('transport')) {
    const direct = sent.filter(row => row.category === 'transport').map(row => row.vehicle_size || '');
    // Заявка без сохранённых потребностей (рассылка кнопками Telegram): подходящие классы — те, которым её отправляли.
    sentSizes = stored ? needSizes(stored) : direct.includes('') ? [] : VAN_SIZE_ORDER.filter(size => direct.includes(size));
    sizes = !sentSizes.length || input.transportAny ? [] : VAN_SIZE_ORDER.filter(size => sentSizes.includes(size) || chosen.includes(size));
  }
  return {
    categories, sizes, details,
    cityId: sent.length ? order.city_id || await cityFor(order, null) : await cityFor(order, input.cityId),
    // Что уже разослано и потому не редактируется; anySize — перевозка разослана без ограничения по размеру.
    locked: { categories: locked, sizes: sentSizes, anySize: locked.includes('transport') && !sentSizes.length },
  };
}

// Потребности из базы в виде полей формы — чтобы посчитать и показать экран до правок менеджера.
function storedInput(order) {
  const services = order.requirements?.configured ? order.requirements.services || {} : {};
  const text = value => value === true ? 'on' : String(value);
  return {
    needs: Array.isArray(order.target_categories) ? order.target_categories : [],
    transportSize: needSizes(order.requirements),
    needAttributes: Object.fromEntries(Object.entries(services).map(([key, values]) => [key, Object.fromEntries(Object.entries(values || {}).map(([field, value]) => [field, text(value)]))])),
  };
}

const stable = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

// Сохраняет потребности с экрана менеджера по правилам draft. Версия заявки растёт, только если
// что-то изменилось, — по ней рассылка замечает чужую правку между расчётом и отправкой.
async function apply(token, input) {
  const changed = await pool.withTransaction(async client => {
    const order = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE',[token])).rows[0];
    if (!order || !['pending_review','new'].includes(order.status)) throw new Error('Заявка закрыта или не найдена');
    const next = await draft(order, input, client);
    if (!next.categories.length) throw new Error('Отметьте хотя бы одну услугу');
    const requirements = requirementsOf(next.sizes, next.details);
    const before = [Array.isArray(order.target_categories) ? order.target_categories : [], order.requirements?.configured ? order.requirements : null, order.city_id];
    if (stable(before) === stable([next.categories, requirements, next.cityId])) return false;
    await client.query('UPDATE orders SET target_categories=$2,requirements=$3::jsonb,city_id=$4,revision_version=revision_version+1 WHERE token=$1',
      [token,next.categories,JSON.stringify(requirements),next.cityId]);
    return true;
  });
  const order = await orderService.getOrderByToken(token);
  if (changed) await require('./telegram.service').updateMessage(order);
  return order;
}

module.exports = {save, draft, apply, storedInput, requirementsOf};
