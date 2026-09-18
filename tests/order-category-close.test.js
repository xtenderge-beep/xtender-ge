const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');
const db = newDb();
const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
db.public.none(schema);
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const before = db.backup(); try { return await fn(pool); } catch (e) { before.restore(); throw e; } };
const stub = (name, exports) => require.cache[require.resolve(name)] = { exports };
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/sms.service', { sendOtp: async () => ({}), sendOrderNotification: async () => ({ ok: true }) });
const orderService = require('../src/services/order.service');
const dispatchService = require('../src/services/dispatch.service');

const newOrder = async (token, categories, status = 'new') => (await pool.query(
  'INSERT INTO orders(token,phone,description,status,target_categories) VALUES($1,$2,$3,$4,$5) RETURNING *',
  [token, '+995500000010', 'Переезд: грузчики и машина', status, categories]
)).rows[0];
const logs = async (orderId) => (await pool.query(
  'SELECT event_type, metadata FROM sms_consent_logs WHERE order_id=$1 ORDER BY id', [orderId]
)).rows;
const types = (rows) => rows.map(r => r.event_type);

(async () => {
  // --- Клиент закрывает одну категорию из двух: заявка остаётся активной для второй.
  const o1 = await newOrder('cat-tok-1', ['movers', 'transport']);
  const afterFirst = await orderService.closeOrderCategory('cat-tok-1', 'movers', { actor: 'client', reason: 'found_provider', meta: {} });
  assert.equal(afterFirst.status, 'new', 'partial close must not close the whole order');
  assert.deepEqual(await orderService.getClosedCategories(o1.id), ['movers']);
  assert.equal((await orderService.getOrderByToken('cat-tok-1')).status, 'new', 'orders.status untouched in the DB');
  let l1 = await logs(o1.id);
  assert.deepEqual(types(l1), ['ORDER_CATEGORY_CLOSED', 'CONTACT_SHARING_WITHDRAWN'], 'no ORDER_CLOSED while a category is still open');
  assert.equal(l1[0].metadata.category, 'movers');
  assert.deepEqual(l1[0].metadata.remaining_categories, ['transport']);
  assert.equal(l1[1].metadata.scope, 'category:movers', 'consent withdrawal is scoped to the closed category');

  // Повторное закрытие той же категории и категория вне заявки — тихий no-op.
  await orderService.closeOrderCategory('cat-tok-1', 'movers', { actor: 'client', reason: 'found_provider', meta: {} });
  await orderService.closeOrderCategory('cat-tok-1', 'trash', { actor: 'client', reason: 'found_provider', meta: {} });
  assert.deepEqual(await orderService.getClosedCategories(o1.id), ['movers'], 'no duplicate / foreign closure rows');
  assert.equal((await logs(o1.id)).length, 2, 'no-ops write no extra audit rows');

  // --- Закрытие последней открытой категории закрывает заявку целиком тем же путём, что close().
  const full = await orderService.closeOrderCategory('cat-tok-1', 'transport', { actor: 'client', reason: 'found_provider', meta: {} });
  assert.equal(full.status, 'closed', 'closing the last open category closes the order');
  assert.equal(full.closed_by, 'client');
  assert.equal(full.closing_reason, 'found_provider');
  l1 = await logs(o1.id);
  assert.deepEqual(types(l1).filter(t => t === 'ORDER_CLOSED').length, 1, 'ORDER_CLOSED written exactly once');
  assert.equal(l1[l1.length - 1].metadata.scope, 'this_order', 'full close withdraws consent for the whole order');
  assert.deepEqual(await orderService.getClosedCategories(o1.id), ['movers'], 'the last category is closed via orders.status, not a closure row');

  // Закрытая заявка: дальнейшие вызовы ничего не меняют.
  const again = await orderService.closeOrderCategory('cat-tok-1', 'movers', { actor: 'client', reason: 'found_provider', meta: {} });
  assert.equal(again.status, 'closed');
  assert.equal((await logs(o1.id)).length, l1.length, 'closed order: no extra audit rows');

  // --- Модератор: частичное закрытие пишет журнал категории, но не «отзыв согласия клиента».
  const o2 = await newOrder('cat-tok-2', ['movers', 'transport']);
  await orderService.closeOrderCategory('cat-tok-2', 'transport', { actor: 'admin', reason: 'admin_closed', meta: {} });
  assert.deepEqual(types(await logs(o2.id)), ['ORDER_CATEGORY_CLOSED'], 'admin close is not a client consent withdrawal');
  assert.equal((await orderService.getOrderByToken('cat-tok-2')).status, 'new');

  // --- Заявка с одной категорией: закрытие этой категории = закрытие заявки.
  const o3 = await newOrder('cat-tok-3', ['movers']);
  const single = await orderService.closeOrderCategory('cat-tok-3', 'movers', { actor: 'client', reason: 'no_longer_needed', meta: {} });
  assert.equal(single.status, 'closed', 'single-category order closes as before');
  assert.deepEqual(await orderService.getClosedCategories(o3.id), []);

  // --- Заявка без категорий (ещё не распределена) и несуществующая.
  const o4 = await newOrder('cat-tok-4', [], 'pending_review');
  const undispatched = await orderService.closeOrderCategory('cat-tok-4', 'movers', { actor: 'client', reason: 'found_provider', meta: {} });
  assert.equal(undispatched.status, 'pending_review', 'nothing to close on an undispatched order');
  assert.deepEqual(await orderService.getClosedCategories(o4.id), []);
  assert.equal(await orderService.closeOrderCategory('nope', 'movers', {}), null);

  // --- Рассылка: закрытую категорию нельзя запустить повторно, даже другим размером транспорта.
  const o5 = await newOrder('cat-tok-5', ['transport', 'movers']);
  await pool.query("INSERT INTO order_dispatches(order_id,category,vehicle_size) VALUES($1,'transport','L')", [o5.id]);
  await orderService.closeOrderCategory('cat-tok-5', 'transport', { actor: 'client', reason: 'found_provider', meta: {} });
  await assert.rejects(
    () => dispatchService.preview('cat-tok-5', 'transport', 'XL'),
    /уже закрыта/,
    'dispatch to a closed category is refused (new vehicle size must not bypass the closure)'
  );
  const open = await dispatchService.preview('cat-tok-5', 'movers', '');
  assert.equal(open.category, 'movers', 'the still-open category can be dispatched');

  console.log('order-category-close.test.js: all assertions passed');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
