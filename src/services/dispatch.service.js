const orderService = require('./order.service');
const settingsService = require('./settings.service');
const pool = require('../config/db');
const { parseDispatchLanguage, speaks, speakLabels, languageBreakdown } = require('../config/spokenLanguages');
const { vanSizeSpec, vanVehicles, vanVehicleLabel } = require('../config/serviceTypes');
const matching = require('./serviceMatching.service');
const orderNeeds = require('./orderNeeds.service');
const vanOf = master => master.services.find(s => s.service_type === 'van');
async function validate(category, size) {
  const groups = await require('./category.service').groups();
  if (!Object.hasOwn(groups, category) || (size && (category !== 'transport' || !require('../config/serviceTypes').VAN_SIZE_ORDER.includes(size)))) throw new Error('Некорректная группа рассылки');
}
function parseLanguage(value) {
  const language = parseDispatchLanguage(value);
  if (language === null) throw new Error('Некорректный язык рассылки');
  return language;
}
// language: '' — всем исполнителям группы, иначе только тем, кто отметил этот язык при регистрации.
// Кто заявку уже получил (прежней отправкой другому языку или размеру), повторно не входит ни в число
// получателей, ни в списание: поэтому «всем» после «говорят по-русски» считает только оставшихся.
async function preview(token, category, size, languageRaw = '') {
  await validate(category, size);
  const language = parseLanguage(languageRaw);
  const order = await orderService.getOrderByToken(token);
  if (!order || !['pending_review', 'new'].includes(order.status)) throw new Error('Заявка закрыта или не найдена');
  // Классы кузова, подходящие заявке. Один класс подставляется сам; при нескольких рассылка без
  // явного класса идёт всем подходящим сразу.
  const allowedSizes = category === 'transport' ? matching.needSizes(order.requirements) : [];
  if (!size && allowedSizes.length === 1) size = allowedSizes[0];
  // Категорию, которую заказчик или модератор уже закрыл (order_category_closures), нельзя
  // рассылать снова, даже другим размером транспорта или языком: unique-ключ order_dispatches
  // включает размер и язык, и без этой проверки исполнители закрытой категории получили бы
  // платный лид по заявке, которую для них уже закрыли.
  if ((await orderService.getClosedCategories(order.id)).includes(category)) throw new Error('Эта категория заявки уже закрыта');
  if(order.requirements?.configured && !order.target_categories.includes(category)) throw new Error('Эта услуга не указана в потребностях заявки');
  if(size && allowedSizes.length && !allowedSizes.includes(size)) throw new Error('Размер не соответствует потребности заявки');
  const price = await settingsService.getLeadPriceTetri();
  const city = (await pool.query('SELECT name_ru FROM cities WHERE id=$1', [order.city_id || (await pool.query("SELECT id FROM cities WHERE slug='tbilisi'")).rows[0]?.id])).rows[0];
  const eligible = await orderService.getDispatchRecipients(category, size, price, order.is_technical === true, '', order);
  const definition = await require('./category.service').get(category);
  const fields = definition ? require('./category.service').view(definition, 'ru').fields : [];
  const criteria = Object.entries(order.requirements?.services?.[category] || {}).map(([key,value]) => {
    const field = fields.find(item => item.key === key);
    const shown = field?.options?.find(option => option.value === value)?.label || (value === true ? 'Да' : String(value));
    return {label:field?.label || key,value:shown + (field?.unit && typeof value === 'number' ? ' '+field.unit : '')};
  });
  if (size || allowedSizes.length) criteria.unshift({label:'Размер транспорта',value:size || allowedSizes.join(', ')});
  if (city) criteria.unshift({label:'Город заявки',value:city.name_ru});
  let attributeExcluded = 0;
  if (Object.keys(order.requirements?.services?.[category] || {}).length) {
    const broadOrder = {...order,requirements:{...order.requirements,services:{},rules:{}}};
    attributeExcluded = Math.max(0,(await orderService.getDispatchRecipients(category,size,price,order.is_technical === true,'',broadOrder)).length-eligible.length);
  }
  const received = await orderService.getChargedMasterIds(order.id);
  const pending=new Set((await pool.query("SELECT master_id FROM dispatch_deliveries WHERE order_id=$1 AND status='pending'",[order.id])).rows.map(d=>d.master_id));
  const fresh = eligible.filter(master => !received.has(master.id) && !pending.has(master.id));
  const recipients = language ? fresh.filter(master => speaks(master, language)) : fresh;
  // В списке получателей перевозки модератор видит, какая машина исполнителя подошла; если машин
  // у него больше, это тоже видно.
  if (['transport', 'flatbed'].includes(category)) recipients.forEach(master => {
    const van = vanOf(master), total = vanVehicles(van.attributes).length;
    const fitting = matching.fitting(van, category, size || allowedSizes, order.requirements);
    master.van_body = fitting.map(vanVehicleLabel).join('; ') + (total > fitting.length ? ' (всего машин: ' + total + ')' : '');
  });
  const inScope = language ? eligible.filter(master => speaks(master, language)) : eligible;
  const previous = await pool.query(`SELECT language FROM order_dispatches WHERE order_id = $1 AND category = $2 AND vehicle_size = $3`, [order.id, category, size || '']);
  const sentLanguages = previous.rows.map(row => row.language);
  return {
    order, category, size: size || '', language, price, recipients, count: recipients.length, criteria, attributeExcluded,
    alreadySent: sentLanguages.includes(language), sentLanguages,
    // Подходящие по группе и языку, но уже получившие эту заявку раньше.
    alreadyReceived: inScope.filter(m=>received.has(m.id)).length,
    pending: inScope.filter(m=>pending.has(m.id)).length,
    // Сколько ещё не получивших говорит на каждом языке — для выбора адресата.
    languages: languageBreakdown(fresh),
  };
}
// Варианты размера кузова для формы «Что нужно клиенту?»: что значит каждая буква и сколько
// исполнителей перевозок получат заявку при её выборе. Считаются те, кому заявку можно
// отправить сейчас (активны, допущены к списанию, работают в городе заявки); остальные
// требования заявки не учитываются. Исполнитель с несколькими машинами считается в
// каждом своём классе. unknown — исполнители, у которых размер неизвестен у всех машин: они
// получают заявку, только когда размер не ограничен.
async function transportSizes(order) {
  const thresholds = await settingsService.getVanSizeThresholds();
  const price = await settingsService.getLeadPriceTetri();
  const all = await orderService.getDispatchRecipients('transport', '', price, order.is_technical === true, '', { ...order, target_categories: [], requirements: {} });
  const classes = new Map(all.map(master => [master.id, vanVehicles(vanOf(master)?.attributes).map(vehicle => vehicle.size).filter(Boolean)]));
  return {
    total: all.length, unknown: all.filter(master => !classes.get(master.id).length).length,
    sizes: thresholds.map(t => ({ code: t.code, spec: vanSizeSpec(t.code, thresholds), count: all.filter(master => classes.get(master.id).includes(t.code)).length })),
  };
}
// Сколько исполнителей каждой услуги могут получить заявку в её городе, без требований: для строк
// экрана менеджера, которые он ещё не отметил.
async function availability(order) {
  const price = await settingsService.getLeadPriceTetri();
  const scope = { ...order, target_categories: [], requirements: {} };
  const counts = {};
  for (const key of Object.keys(await require('./category.service').groups())) counts[key] = (await orderService.getDispatchRecipients(key, '', price, order.is_technical === true, '', scope)).length;
  return counts;
}

// Расчёт для экрана менеджера: кто получит заявку по отмеченным услугам и требованиям, которые ещё
// не сохранены. Ничего не пишет. У услуги может быть несколько отправок: перевозка рассылается
// отдельно каждому выбранному классу кузова (ключ рассылки — услуга, класс и язык), и класс можно
// добавить позже. Исполнитель, подходящий нескольким услугам или классам, считается один раз.
async function planNeeds(token, input, languageRaw = '') {
  const language = parseLanguage(languageRaw);
  const order = await orderService.getOrderByToken(token);
  if (!order || !['pending_review', 'new'].includes(order.status)) throw new Error('Заявка закрыта или не найдена');
  const needs = await orderNeeds.draft(order, input);
  const virtual = { ...order, city_id: needs.cityId, target_categories: needs.categories, requirements: orderNeeds.requirementsOf(needs.sizes, needs.details) };
  const price = await settingsService.getLeadPriceTetri();
  const labels = await require('./category.service').groups();
  const closed = await orderService.getClosedCategories(order.id);
  const received = await orderService.getChargedMasterIds(order.id);
  const pending = new Set((await pool.query("SELECT master_id FROM dispatch_deliveries WHERE order_id=$1 AND status='pending'", [order.id])).rows.map(d => d.master_id));
  const sent = (await pool.query('SELECT category, vehicle_size, language FROM order_dispatches WHERE order_id=$1', [order.id])).rows;
  const wasSent = (category, size) => sent.some(row => row.category === category && (row.vehicle_size || '') === size && (row.language || '') === language);
  const thresholds = await settingsService.getVanSizeThresholds();
  const services = [];
  for (const key of needs.categories) {
    const service = { key, label: labels[key] || key, closed: closed.includes(key), locked: needs.locked.categories.includes(key), count: 0, recipients: [], groups: [], alreadyReceived: 0, unfunded: 0, otherLanguage: 0 };
    services.push(service);
    if (service.closed) continue;
    const transport = key === 'transport';
    // Все, кто подходит услуге в городе заявки, включая тех, кому её не отправить; у перевозки —
    // без учёта класса, чтобы показать числа по каждому классу.
    const scope = transport ? { ...virtual, requirements: orderNeeds.requirementsOf([], needs.details) } : virtual;
    // Язык применяем здесь, а не в подборе: менеджеру видно, скольких отсеял именно он.
    const all = await orderService.getDispatchRecipients(key, '', price, order.is_technical === true, '', scope, { withUnfunded: true });
    const inLanguage = master => !language || speaks(master, language);
    const vehicles = new Map(all.map(master => [master.id, ['transport', 'flatbed'].includes(key) ? matching.fitting(vanOf(master), key, '', virtual.requirements) : []]));
    const classes = master => vehicles.get(master.id).map(vehicle => vehicle.size).filter(Boolean);
    const qualified = all.filter(master => !transport || !needs.sizes.length || classes(master).some(size => needs.sizes.includes(size)));
    const available = master => master.funded && !received.has(master.id) && !pending.has(master.id);
    const fresh = master => available(master) && inLanguage(master);
    service.alreadyReceived = qualified.filter(master => received.has(master.id)).length;
    service.unfunded = qualified.filter(master => !master.funded && !received.has(master.id) && inLanguage(master)).length;
    service.otherLanguage = qualified.filter(master => available(master) && !inLanguage(master)).length;
    service.groups = (transport && needs.sizes.length ? needs.sizes : ['']).map(size => {
      const members = qualified.filter(master => fresh(master) && (!size || classes(master).includes(size)));
      return { size, sent: wasSent(key, size), ids: members.map(master => master.id), sendable: !wasSent(key, size) && members.length > 0 };
    });
    const ids = new Set(service.groups.filter(group => group.sendable).flatMap(group => group.ids));
    service.recipients = qualified.filter(master => ids.has(master.id)).map(master => ({
      id: master.id, name: master.name,
      body: vehicles.get(master.id).filter(vehicle => !transport || !needs.sizes.length || needs.sizes.includes(vehicle.size)).map(vanVehicleLabel).join('; '),
    }));
    service.count = service.recipients.length;
    if (transport) {
      service.sizes = thresholds.map(t => ({ code: t.code, spec: vanSizeSpec(t.code, thresholds), sent: wasSent(key, t.code), count: all.filter(master => fresh(master) && classes(master).includes(t.code)).length }));
      service.anySent = wasSent(key, '');
      service.anyCount = all.filter(fresh).length;
      service.unknown = all.filter(master => fresh(master) && !classes(master).length).length;
    }
  }
  const total = new Set(services.flatMap(service => service.recipients.map(master => master.id))).size;
  return { order, needs, language, price, services, total, charge: total * price, revision: order.revision_version || 0 };
}

// Одна кнопка экрана менеджера: сохранить потребности и разослать заявку всем отмеченным услугам.
// expected — числа, которые менеджер видел перед нажатием; если состав получателей, тариф или сама
// заявка с тех пор изменились, ничего не отправляется. Услуги рассылаются по очереди обычной
// рассылкой (dispatch), поэтому списание остаётся одно на исполнителя и заявку.
async function sendNeeds(token, input, expected = null, languageRaw = '', context = {}) {
  const plan = await planNeeds(token, input, languageRaw);
  if (expected && (Number(expected.total) !== plan.total || Number(expected.price) !== plan.price || Number(expected.revision) !== plan.revision)) {
    throw new Error('Состав получателей, тариф или заявка изменились. Проверьте числа и отправьте ещё раз.');
  }
  if (!plan.total) throw new Error('Отправлять некому: новых получателей нет.');
  await orderNeeds.apply(token, input);
  if (context.shareBrief !== undefined) await require('./orderBrief.service').setShared(token, context.shareBrief === true);
  const results = [];
  for (const service of plan.services) for (const group of service.groups.filter(item => item.sendable)) {
    const result = { key: service.key, label: service.label, size: group.size, count: 0 };
    results.push(result);
    try {
      const fresh = await preview(token, service.key, group.size, plan.language);
      // Ноль — когда все подходящие уже получили заявку по другой услуге или классу этой же отправки.
      if (fresh.count) result.count = (await dispatch(token, service.key, group.size, { price: fresh.price, count: fresh.count, revision: fresh.order.revision_version || 0 }, plan.language, { actor: context.actor })).count;
    } catch (error) { result.error = error.message; }
  }
  return { results, count: results.reduce((sum, result) => sum + result.count, 0), price: plan.price };
}
// Расчёт в виде, который уходит в браузер менеджера: без телефонов и прочих данных заявки.
function planView(plan) {
  return {
    total: plan.total, charge: plan.charge, price: plan.price, revision: plan.revision, sizes: plan.needs.sizes, language: plan.language,
    services: plan.services.map(service => ({
      key: service.key, closed: service.closed, count: service.count, alreadyReceived: service.alreadyReceived, unfunded: service.unfunded, otherLanguage: service.otherLanguage,
      recipients: service.recipients.map(master => ({ name: master.name, body: master.body })),
      sent: service.groups.filter(group => group.sent).map(group => group.size),
      sizes: service.sizes, anySent: service.anySent, anyCount: service.anyCount, unknown: service.unknown,
    })),
  };
}

// Всё, что показывает экран менеджера по заявке: заявка с фото, строки услуг с расчётом по
// сохранённым потребностям, отправки и отклики.
async function screen(token, languageRaw = '') {
  const order = await orderService.getOrderByToken(token);
  if (!order) return null;
  // pg-mem отдаёт пустой массив и jsonb строкой.
  if (typeof order.requirements === 'string') order.requirements = JSON.parse(order.requirements);
  if (!Array.isArray(order.target_categories)) order.target_categories = [];
  const categoryService = require('./category.service'), masterService = require('./master.service');
  const open = ['pending_review', 'new'].includes(order.status);
  const plan = open ? await planNeeds(token, orderNeeds.storedInput(order), languageRaw) : null;
  const available = open ? await availability(order) : {};
  const groups = await categoryService.groups(), config = await categoryService.configForView('ru');
  const closed = await orderService.getClosedCategories(order.id);
  const needs = plan?.needs || { categories: order.target_categories, sizes: matching.needSizes(order.requirements), details: { services: order.requirements?.services || {} }, locked: { categories: order.target_categories, sizes: [], anySize: false } };
  // «Бортовая» отдельной строкой показывается только там, где её уже выбрали: в новых заявках
  // это «Перевозки» с типом кузова «борт» — так у бортовой есть и размер.
  const rows = Object.entries(groups).filter(([key]) => key !== 'flatbed' || needs.categories.includes(key)).map(([key, label]) => ({
    key, label: key === 'flatbed' ? '🚛 Перевозки — бортовая машина' : label,
    fields: (config.find(svc => svc.type === matching.toType(key))?.fields || []).filter(f => f.input !== 'size' && f.input !== 'text' && f.match && f.match !== 'ignore' && !(key === 'flatbed' && f.key === 'body')),
    values: needs.details.services?.[key] || {}, checked: needs.categories.includes(key), locked: !open || needs.locked.categories.includes(key), closed: closed.includes(key), available: available[key] ?? 0,
  }));
  const runs = await orderService.getOrderDispatches(order.id);
  const ids = [...new Set(runs.flatMap(run => run.deliveries.map(delivery => delivery.master_id)))];
  const names = ids.length ? Object.fromEntries((await pool.query('SELECT id, name FROM masters WHERE id IN (' + ids.map((_, index) => '$' + (index + 1)).join(',') + ')', ids)).rows.map(master => [master.id, master.name])) : {};
  const thresholds = await settingsService.getVanSizeThresholds();
  const files = await orderService.getOrderFiles(order.id);
  const image = file => String(file.mime_type || '').startsWith('image/');
  // Карточка «Кратко» и связь с заказчиком. В WhatsApp уходит приветствие на языке заявки и, если
  // ИИ нашёл пробелы, готовые вопросы — менеджер правит текст уже в переписке.
  const briefService = require('./orderBrief.service'), brief = briefService.read(order);
  const requestLang = require('../config/requestLanguage').ofOrder(order);
  const digits = String(order.phone || '').replace(/\D/g, '');
  const greeting = require('../config/service-message-copy')('clarifyGreeting', requestLang || 'ru', { id: order.id });
  return {
    brief, briefLines: briefService.lines(brief, 'ru'), briefEnabled: briefService.enabled(),
    briefServices: (brief?.services || []).filter(key => Object.hasOwn(groups, key)).map(key => ({ key, label: groups[key] })),
    whatsappUrl: digits.length >= 8 ? 'https://wa.me/' + digits + '?text=' + encodeURIComponent(greeting + (brief?.questions ? ' ' + brief.questions : '')) : null,
    canEditText: order.status === 'pending_review' && !order.first_dispatched_at,
    order, open, rows, needs, runs, names, groups, closedCategories: closed, planView: plan ? planView(plan) : null, language: plan?.language || '',
    sizes: thresholds.map(t => ({ code: t.code, spec: vanSizeSpec(t.code, thresholds) })),
    photos: files.filter(image), documents: files.filter(file => !image(file)),
    requestLanguage: requestLang, languageNames: require('../config/spokenLanguages').ruNames,
    activeCities: await masterService.getActiveCities(), allCities: await masterService.getWorkCities(),
    funnel: await orderService.getOrderFunnelStats(order.id), funnelByCategory: await orderService.getOrderFunnelByCategory(order.id), speakLabels,
  };
}
// Почему получателей нет — для сообщения модератору (Telegram и админка).
function emptyReason(plan) {
  if (plan.pending > 0) return 'Есть отправки в обработке или с неопределённым результатом. Проверьте результаты';
  if (plan.alreadyReceived > 0) return 'Все подходящие исполнители уже получили эту заявку';
  if (plan.attributeExcluded > 0) return 'Нет исполнителей, соответствующих выбранным характеристикам заявки';
  if (plan.language) return 'Нет исполнителей с активным профилем и достаточным балансом, которые говорят ' + speakLabels[plan.language];
  return 'Нет исполнителей с активным профилем и достаточным балансом';
}
async function dispatch(token, category, size, expected = null, languageRaw = '', context = {}) {
  const plan = await preview(token, category, size, languageRaw);
  size = plan.size;
  // Повторное нажатие на ту же кнопку: после первой отправки состав получателей уже изменился, но
  // объяснять надо «уже запускалась», а не «состав изменился».
  if (plan.alreadySent) throw new Error('Рассылка этой группе уже запускалась. Откройте результаты рассылки.');
  if (expected && (Number(expected.price) !== plan.price || Number(expected.count) !== plan.count)) throw new Error('Состав группы или тариф изменился. Обновите предварительный расчёт.');
  if (expected && Number(expected.revision) !== Number(plan.order.revision_version || 0)) throw new Error('Заявка изменена. Обновите предварительный расчёт.');
  if (!plan.count) throw new Error(emptyReason(plan));
  // Database uniqueness is shared by Telegram and the admin form, including concurrent clicks.
  if (!await orderService.recordDispatch(plan.order.id, category, size || null, plan.order.revision_version || 0, plan.language)) throw new Error('Рассылка этой группе уже запускалась');
  await orderService.markFirstDispatch(token);
  const order = await orderService.addTargetCategories(token, [category]);
  if(!order) throw new Error('Заявка закрыта или изменена до отправки');
  const count = await orderService.notifyMasters(order, category, size || null, plan.price, plan.language, context);
  const telegramService = require('./telegram.service');
  telegramService.updateMessage(order).catch(err => console.error('Dispatch message update failed:', err.message));
  return { count, price: plan.price, run: (await orderService.getOrderDispatches(order.id)).find(r=>r.id === context.runId) };
}
async function retry(token, runId, actor='admin') {
  const order=await orderService.getOrderByToken(token);
  const run=order && (await orderService.getOrderDispatches(order.id)).find(r=>r.id === Number(runId));
  if(!run) throw new Error('Рассылка не найдена');
  const plan=await preview(token,run.category,run.vehicle_size,run.language);
  // Claim failures atomically. Repeated/concurrent clicks cannot claim them twice.
  const context=await pool.withTransaction(async client=>{
    await client.query('SELECT id FROM dispatch_runs WHERE id=$1 FOR UPDATE',[run.id]);
    const rows=(await client.query("SELECT * FROM dispatch_deliveries WHERE run_id=$1 AND status='failed' AND retry_run_id IS NULL",[run.id])).rows;
    const eligible=new Set(plan.recipients.map(m=>m.id));
    const selected=rows.filter(r=>eligible.has(r.master_id));
    if(!selected.length) throw new Error('Нет подтверждённых ошибок с подходящими получателями для повтора');
    const next=(await client.query('INSERT INTO dispatch_runs(order_id,category,vehicle_size,language,initiated_by,revision,retry_of) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[order.id,run.category,run.vehicle_size,run.language,actor,order.revision_version || 0,run.id])).rows[0];
    for(const row of selected) {
      await client.query('UPDATE dispatch_deliveries SET retry_run_id=$3 WHERE run_id=$1 AND master_id=$2',[run.id,row.master_id,next.id]);
      await client.query('INSERT INTO dispatch_deliveries(run_id,order_id,master_id,manager_id,matched_categories,service_snapshot) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[next.id,order.id,row.master_id,row.manager_id,JSON.stringify(row.matched_categories),JSON.stringify(row.service_snapshot)]);
    }
    return {actor,preparedRun:next,recipientIds:selected.map(r=>r.master_id)};
  });
  const count=await orderService.notifyMasters(order,run.category,run.vehicle_size,plan.price,run.language,context);
  await require('./telegram.service').updateMessage(order);
  return {count,price:plan.price,run:(await orderService.getOrderDispatches(order.id)).find(r=>r.id===context.runId)};
}
module.exports = { preview, dispatch, retry, validate, emptyReason, transportSizes, availability, planNeeds, planView, sendNeeds, screen };
