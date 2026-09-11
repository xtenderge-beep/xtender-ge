const orderService = require('./order.service');
const settingsService = require('./settings.service');
const pool = require('../config/db');
const groups = { transport: 'Перевозки', flatbed: 'Открытый кузов', movers: 'Грузчики', tow: 'Эвакуатор', bucket_lift: 'Автовышка', junk: 'Вывоз — старые профили' };
function validate(category, size) {
  if (!Object.hasOwn(groups, category) || (size && (category !== 'transport' || !['S','L','XL','XXL'].includes(size)))) throw new Error('Некорректная группа рассылки');
}
async function preview(token, category, size) {
  validate(category, size);
  const order = await orderService.getOrderByToken(token);
  if (!order || order.status === 'closed') throw new Error('Заявка закрыта или не найдена');
  const price = await settingsService.getLeadPriceTetri();
  const recipients = await orderService.getDispatchRecipients(category, size, price);
  const previous = await pool.query(`SELECT id FROM order_dispatches WHERE order_id = $1 AND category = $2 AND vehicle_size = $3`, [order.id, category, size || '']);
  return { order, category, size: size || '', price, count: recipients.length, alreadySent: previous.rows.length > 0 };
}
async function dispatch(token, category, size, expected = null) {
  const plan = await preview(token, category, size);
  if (expected && (Number(expected.price) !== plan.price || Number(expected.count) !== plan.count)) throw new Error('Состав группы или тариф изменился. Обновите предварительный расчёт.');
  if (plan.alreadySent) throw new Error('Рассылка этой группе уже запускалась. Проверьте историю списаний.');
  if (!plan.count) throw new Error('Нет исполнителей с активным профилем и достаточным балансом');
  // Database uniqueness is shared by Telegram and the admin form, including concurrent clicks.
  if (!await orderService.recordDispatch(plan.order.id, category, size || null)) throw new Error('Рассылка этой группе уже запускалась');
  await orderService.markFirstDispatch(token);
  const order = await orderService.addTargetCategories(token, [category]);
  const count = await orderService.notifyMasters(order, category, size || null, plan.price);
  const telegramService = require('./telegram.service');
  telegramService.updateMessage(order).catch(err => console.error('Dispatch message update failed:', err.message));
  return { count, price: plan.price };
}
module.exports = { groups, preview, dispatch, validate };
