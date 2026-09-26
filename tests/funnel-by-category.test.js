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
const telegram = require('../src/services/telegram.service');

let phoneSeq = 0;
const master = async (name, category) => (await pool.query(
  'INSERT INTO masters(name,phone,category,balance_tetri) VALUES($1,$2,$3,10000) RETURNING id',
  [name, '+99550010' + String(++phoneSeq).padStart(4, '0'), category]
)).rows[0].id;
const order = async (token, status = 'new') => (await pool.query(
  "INSERT INTO orders(token,phone,description,status,target_categories) VALUES($1,'+995500000099','Переезд',$2,$3) RETURNING *",
  [token, status, ['movers', 'transport']]
)).rows[0];
const dispatched = (orderId, category, size = '') => pool.query('INSERT INTO order_dispatches(order_id,category,vehicle_size) VALUES($1,$2,$3)', [orderId, category, size]);
const delivery = async (runId, orderId, masterId, status) => {
  const category=(await pool.query('SELECT category FROM masters WHERE id=$1',[masterId])).rows[0].category;
  return pool.query('INSERT INTO dispatch_deliveries(run_id,order_id,master_id,status,matched_categories) VALUES($1,$2,$3,$4,$5::jsonb)',[runId,orderId,masterId,status,JSON.stringify([category])]);
};
const event = (orderId, masterId, type) => pool.query('INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,$3)', [orderId, masterId, type]);
const rowFor = (rows, category) => rows.find(r => r.category === category);

(async () => {
  const m1 = await master('Грузчик 1', 'movers');
  const m2 = await master('Грузчик 2', 'movers');
  const m3 = await master('Грузчик 3', 'movers');       // не получил лид (skipped)
  const t1 = await master('Машина 1', 'transport');
  const t2 = await master('Машина 2', 'transport');

  // --- Заявка «грузчики + машина»: разбивка по группам считает своих мастеров отдельно.
  const o1 = await order('fun-tok-1');
  await dispatched(o1.id, 'movers');
  await dispatched(o1.id, 'transport', 'XL');
  const run = (await pool.query('INSERT INTO dispatch_runs(order_id) VALUES($1) RETURNING id', [o1.id])).rows[0].id;
  await delivery(run, o1.id, m1, 'accepted');
  await delivery(run, o1.id, m2, 'accepted');
  await delivery(run, o1.id, m3, 'skipped');
  await delivery(run, o1.id, t1, 'accepted');
  await delivery(run, o1.id, t2, 'accepted');
  // Грузчики: оба открыли, оба позвонили, один ещё и написал в WhatsApp. Машины: открыл один.
  for (const [who, type] of [[m1, 'view'], [m1, 'call'], [m1, 'whatsapp'], [m2, 'view'], [m2, 'call'], [t1, 'view']]) await event(o1.id, who, type);

  const rows = await orderService.getOrderFunnelByCategory(o1.id);
  assert.deepEqual(rows.map(r => r.category), ['movers', 'transport'], 'groups come in dispatch order');
  assert.deepEqual(rowFor(rows, 'movers'), { category: 'movers', received: 2, view: 2, call: 2, whatsapp: 1, contacted: 2 },
    'skipped delivery does not count as received; a master who called AND wrote counts once as contacted');
  assert.deepEqual(rowFor(rows, 'transport'), { category: 'transport', received: 2, view: 1, call: 0, whatsapp: 0, contacted: 0 });

  // Итог по всем группам совпадает с прежней общей воронкой.
  const totals = await orderService.getOrderFunnelStats(o1.id);
  assert.equal(rows.reduce((s, r) => s + r.view, 0), totals.view);
  assert.equal(rows.reduce((s, r) => s + r.call, 0), totals.call);
  assert.equal(rows.reduce((s, r) => s + r.whatsapp, 0), totals.whatsapp);

  // --- Заявка до появления dispatch_deliveries: «уведомлены» берётся из списания lead_charge.
  const o2 = await order('fun-tok-2');
  await dispatched(o2.id, 'movers');
  await pool.query("INSERT INTO balance_transactions(master_id,order_id,amount_tetri,reason) VALUES($1,$2,-50,'lead_charge')", [m1, o2.id]);
  await event(o2.id, m1, 'whatsapp');
  const legacy = await orderService.getOrderFunnelByCategory(o2.id);
  assert.deepEqual(legacy, [{ category: 'movers', received: 1, view: 0, call: 0, whatsapp: 1, contacted: 1 }], 'legacy order falls back to lead_charge');

  // --- И доставка, и списание одного мастера не задваивают «уведомлены».
  const o3 = await order('fun-tok-3');
  await dispatched(o3.id, 'movers');
  const run3 = (await pool.query('INSERT INTO dispatch_runs(order_id) VALUES($1) RETURNING id', [o3.id])).rows[0].id;
  await delivery(run3, o3.id, m1, 'accepted');
  await pool.query("INSERT INTO balance_transactions(master_id,order_id,amount_tetri,reason) VALUES($1,$2,-50,'lead_charge')", [m1, o3.id]);
  assert.equal(rowFor(await orderService.getOrderFunnelByCategory(o3.id), 'movers').received, 1, 'delivery + charge of one master = 1');

  // --- Группа, которой разослали, но лид никто не получил, остаётся в отчёте нулями.
  const o4 = await order('fun-tok-4');
  await dispatched(o4.id, 'transport', 'L');
  assert.deepEqual(await orderService.getOrderFunnelByCategory(o4.id), [{ category: 'transport', received: 0, view: 0, call: 0, whatsapp: 0, contacted: 0 }]);

  // --- «Бортовые» — не masters.category, а подвыборка transport: учитывается как transport.
  const o5 = await order('fun-tok-5');
  await dispatched(o5.id, 'flatbed');
  assert.deepEqual((await orderService.getOrderFunnelByCategory(o5.id)).map(r => r.category), ['flatbed'], 'flatbed retains its independently closable need');

  // --- Заявка без рассылки — пустой отчёт, без ошибок.
  assert.deepEqual(await orderService.getOrderFunnelByCategory((await order('fun-tok-6', 'pending_review')).id), []);

  // --- Текст сообщения модератору.
  const labels = { movers: '💪 Грузчики', transport: '🚚 Перевозки' };
  const dispatchLines = ['💪 Грузчики — 3', '🚚 Перевозки XL — 2'];
  const text = telegram.buildMessageText({ ...o1, description: 'Переезд', district_name: null }, dispatchLines, totals, { byCategory: rows, labels, closedCategories: ['movers'] });
  assert.match(text, /📊 Действия получателей по предложенным услугам:/);
  assert.match(text, /💪 Грузчики 🔒 закрыта: уведомлены 2 · 👀 2 · 📞 2 · 💬 1 · нажали контакт 2 из 2 \(100%\)/, 'closed group is marked and response rate is shown');
  assert.match(text, /🚚 Перевозки: уведомлены 2 · 👀 1 · 📞 0 · 💬 0 · нажали контакт 0 из 2 \(0%\)/);
  assert.match(text, /Всего: 👀 3 · 📞 2 · 💬 1/);
  assert.doesNotMatch(text, /🚚 Перевозки 🔒/, 'the open group is not marked closed');

  // Без разбивки (или если её запрос упал) сообщение выглядит как раньше.
  const plain = telegram.buildMessageText({ ...o1, description: 'Переезд', district_name: null }, dispatchLines, totals);
  assert.match(plain, /📊 Воронка:\n👀 Перешли по ссылке: 3\n📞 Нажали «Позвонить»: 2\n💬 Нажали «WhatsApp»: 1/);
  assert.doesNotMatch(plain, /по группам/);

  // Группа, где лид никто не получил: без процента (нет деления на ноль).
  const zero = telegram.buildMessageText({ ...o1, description: 'x', district_name: null }, dispatchLines, totals,
    { byCategory: [{ category: 'transport', received: 0, view: 0, call: 0, whatsapp: 0, contacted: 0 }], labels });
  assert.match(zero, /🚚 Перевозки: уведомлены 0 · 👀 0 · 📞 0 · 💬 0(\n|$)/, 'no rate when nobody received the lead');

  console.log('funnel-by-category.test.js: all assertions passed');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
