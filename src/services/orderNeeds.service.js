const pool = require('../config/db');
const categoryService = require('./category.service');
const orderService = require('./order.service');
const { VAN_SIZE_ORDER } = require('../config/serviceTypes');
const requirementsService = require('./serviceRequirements.service');

async function save(token, rawCategories, rawSize, rawAttributes) {
  const categories = [...new Set([].concat(rawCategories || []))];
  const groups = await categoryService.groups();
  const size = rawSize || '';
  if (!categories.length || categories.some(key => typeof key !== 'string' || !Object.hasOwn(groups,key)) ||
      (size && (!VAN_SIZE_ORDER.includes(size) || !categories.includes('transport')))) throw new Error('Выберите потребности и корректный размер транспорта');
  const details = requirementsService.parse(await categoryService.list(),categories,rawAttributes || {});
  await pool.withTransaction(async client => {
    const order = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE',[token])).rows[0];
    if (!order || order.first_dispatched_at || order.status !== 'pending_review') throw new Error('Потребности можно настроить до первой рассылки. После неё можно закрывать отдельные потребности.');
    await client.query('UPDATE orders SET target_categories=$2,requirements=$3::jsonb,revision_version=revision_version+1 WHERE token=$1',
      [token,categories,JSON.stringify({configured:true,transport_size:size,...details})]);
  });
  const order = await orderService.getOrderByToken(token);
  await require('./telegram.service').updateMessage(order);
  return order;
}

module.exports = {save};
