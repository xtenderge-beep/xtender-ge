const orderService = require('./order.service');
const settingsService = require('./settings.service');
const pool = require('../config/db');
const { parseDispatchLanguage, speaks, speakLabels, languageBreakdown } = require('../config/spokenLanguages');
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
  if (category === 'transport') size = size || order.requirements?.transport_size || '';
  // Категорию, которую заказчик или модератор уже закрыл (order_category_closures), нельзя
  // рассылать снова, даже другим размером транспорта или языком: unique-ключ order_dispatches
  // включает размер и язык, и без этой проверки исполнители закрытой категории получили бы
  // платный лид по заявке, которую для них уже закрыли.
  if ((await orderService.getClosedCategories(order.id)).includes(category)) throw new Error('Эта категория заявки уже закрыта');
  if(order.requirements?.configured && !order.target_categories.includes(category)) throw new Error('Эта услуга не указана в потребностях заявки');
  if(category === 'transport' && order.requirements?.transport_size && size && size !== order.requirements.transport_size) throw new Error('Размер не соответствует потребности заявки');
  const price = await settingsService.getLeadPriceTetri();
  const eligible = await orderService.getDispatchRecipients(category, size, price, order.is_technical === true, '', order);
  const definition = await require('./category.service').get(category);
  const fields = definition ? require('./category.service').view(definition, 'ru').fields : [];
  const criteria = Object.entries(order.requirements?.services?.[category] || {}).map(([key,value]) => {
    const field = fields.find(item => item.key === key);
    const shown = field?.options?.find(option => option.value === value)?.label || (value === true ? 'Да' : String(value));
    return {label:field?.label || key,value:shown + (field?.unit && typeof value === 'number' ? ' '+field.unit : '')};
  });
  if (size) criteria.unshift({label:'Размер транспорта',value:size});
  let attributeExcluded = 0;
  if (Object.keys(order.requirements?.services?.[category] || {}).length) {
    const broadOrder = {...order,requirements:{...order.requirements,services:{},rules:{}}};
    attributeExcluded = Math.max(0,(await orderService.getDispatchRecipients(category,size,price,order.is_technical === true,'',broadOrder)).length-eligible.length);
  }
  const received = await orderService.getChargedMasterIds(order.id);
  const pending=new Set((await pool.query("SELECT master_id FROM dispatch_deliveries WHERE order_id=$1 AND status='pending'",[order.id])).rows.map(d=>d.master_id));
  const fresh = eligible.filter(master => !received.has(master.id) && !pending.has(master.id));
  const recipients = language ? fresh.filter(master => speaks(master, language)) : fresh;
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
module.exports = { preview, dispatch, retry, validate, emptyReason };
