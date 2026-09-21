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
  // Категорию, которую заказчик или модератор уже закрыл (order_category_closures), нельзя
  // рассылать снова, даже другим размером транспорта или языком: unique-ключ order_dispatches
  // включает размер и язык, и без этой проверки исполнители закрытой категории получили бы
  // платный лид по заявке, которую для них уже закрыли.
  if ((await orderService.getClosedCategories(order.id)).includes(category)) throw new Error('Эта категория заявки уже закрыта');
  const price = await settingsService.getLeadPriceTetri();
  const eligible = await orderService.getDispatchRecipients(category, size, price, order.is_technical === true);
  const received = await orderService.getChargedMasterIds(order.id);
  const fresh = eligible.filter(master => !received.has(master.id));
  const recipients = language ? fresh.filter(master => speaks(master, language)) : fresh;
  const inScope = language ? eligible.filter(master => speaks(master, language)) : eligible;
  const previous = await pool.query(`SELECT language FROM order_dispatches WHERE order_id = $1 AND category = $2 AND vehicle_size = $3`, [order.id, category, size || '']);
  const sentLanguages = previous.rows.map(row => row.language);
  return {
    order, category, size: size || '', language, price, recipients, count: recipients.length,
    alreadySent: sentLanguages.includes(language), sentLanguages,
    // Подходящие по группе и языку, но уже получившие эту заявку раньше.
    alreadyReceived: inScope.length - recipients.length,
    // Сколько ещё не получивших говорит на каждом языке — для выбора адресата.
    languages: languageBreakdown(fresh),
  };
}
// Почему получателей нет — для сообщения модератору (Telegram и админка).
function emptyReason(plan) {
  if (plan.alreadyReceived > 0) return 'Все подходящие исполнители уже получили эту заявку';
  if (plan.language) return 'Нет исполнителей с активным профилем и достаточным балансом, которые говорят ' + speakLabels[plan.language];
  return 'Нет исполнителей с активным профилем и достаточным балансом';
}
async function dispatch(token, category, size, expected = null, languageRaw = '') {
  const plan = await preview(token, category, size, languageRaw);
  // Повторное нажатие на ту же кнопку: после первой отправки состав получателей уже изменился, но
  // объяснять надо «уже запускалась», а не «состав изменился».
  if (plan.alreadySent) throw new Error('Рассылка этой группе уже запускалась. Проверьте историю списаний.');
  if (expected && (Number(expected.price) !== plan.price || Number(expected.count) !== plan.count)) throw new Error('Состав группы или тариф изменился. Обновите предварительный расчёт.');
  if (expected && Number(expected.revision) !== Number(plan.order.revision_version || 0)) throw new Error('Заявка изменена. Обновите предварительный расчёт.');
  if (!plan.count) throw new Error(emptyReason(plan));
  // Database uniqueness is shared by Telegram and the admin form, including concurrent clicks.
  if (!await orderService.recordDispatch(plan.order.id, category, size || null, plan.order.revision_version || 0, plan.language)) throw new Error('Рассылка этой группе уже запускалась');
  await orderService.markFirstDispatch(token);
  const order = await orderService.addTargetCategories(token, [category]);
  const count = await orderService.notifyMasters(order, category, size || null, plan.price, plan.language);
  const telegramService = require('./telegram.service');
  telegramService.updateMessage(order).catch(err => console.error('Dispatch message update failed:', err.message));
  return { count, price: plan.price };
}
module.exports = { preview, dispatch, validate, emptyReason };
