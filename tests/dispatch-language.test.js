// Рассылка заявки «по языку»: модератор выбирает, кому отправить — всем или тем, кто отметил язык.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (name, exports) => (require.cache[require.resolve(name)] = { exports });
stub('../src/config/db', pool);
stub('../src/config/redis', new (require('ioredis-mock'))());
const sms = [];
stub('../src/services/sms.service', {
  sendOtp: async () => ({ providerMessageId: 'otp' }),
  sendOrderNotification: async (phone, text, context) => { sms.push({ phone, text, context }); return { ok: true, providerMessageId: 'sms-' + sms.length }; },
});
stub('../src/services/translation.service', { translateOrder: async () => null });
const calls = [];
stub('axios', { post: async (url, body) => { calls.push({ url, body }); return { data: { ok: true, result: { message_id: 1 } } }; } });

const orders = require('../src/services/order.service');
const dispatch = require('../src/services/dispatch.service');
const telegram = require('../src/services/telegram.service');
const categories = require('../src/services/category.service');
const admin = require('../src/services/admin.service');
const orderController = require('../src/controllers/order.controller');
const { parseDispatchLanguage, speaks, languageBreakdown, speakLabels } = require('../src/config/spokenLanguages');
const realUpdateMessage = telegram.updateMessage;
telegram.updateMessage = async () => {};

assert.equal(parseDispatchLanguage(undefined), '');
assert.equal(parseDispatchLanguage(''), '');
assert.equal(parseDispatchLanguage('all'), '');
assert.equal(parseDispatchLanguage('ru'), 'ru');
for (const bad of ['xx', '__proto__', 'toString', ['ru'], 5, {}]) assert.equal(parseDispatchLanguage(bad), null);
assert.equal(speaks({ spoken_languages: ['ru'] }, 'ru'), true);
assert.equal(speaks({ spoken_languages: [] }, 'ru'), false);
assert.equal(speaks({ language: 'ru' }, 'ru'), false, 'язык кабинета не считается языком общения');
assert.equal(speaks(null, 'ru'), false);
assert.deepEqual({ ...languageBreakdown([{ spoken_languages: ['ru', 'en'] }, { spoken_languages: [] }, {}]), byLanguage: undefined }, { all: 3, byLanguage: undefined, none: 2 });

async function insertMaster(name, phone, balance, languages) {
  const master = (await pool.query(
    "INSERT INTO masters(name,phone,category,is_active,is_subscribed,balance_tetri,master_token,spoken_languages) VALUES($1,$2,'movers',true,true,$3,$4,$5::jsonb) RETURNING *",
    [name, phone, balance, 'token-' + name, JSON.stringify(languages)])).rows[0];
  await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)", [master.id]);
  await require('./billing-fixture')(pool, master.id);
  return master;
}
const newOrder = async token => (await pool.query("INSERT INTO orders(token,phone,description,status) VALUES($1,'+995500000908','Нужны грузчики','pending_review') RETURNING *", [token])).rows[0];
const balance = async master => Number((await pool.query('SELECT balance_tetri FROM masters WHERE id=$1', [master.id])).rows[0].balance_tetri);
const missed = async master => Number((await pool.query('SELECT missed_dispatch_count FROM masters WHERE id=$1', [master.id])).rows[0].missed_dispatch_count);
const charges = async (order, master) => (await pool.query("SELECT COUNT(*)::int AS n FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge'", [master.id, order.id])).rows[0].n;
const ids = plan => plan.recipients.map(m => m.id).sort((a, b) => a - b);
const go = (plan, language) => dispatch.dispatch(plan.order.token, 'movers', '', { price: plan.price, count: plan.count, revision: 0 }, language);

(async () => {
  const A = await insertMaster('ru-only', '+995500000001', 1000, ['ru']);
  const B = await insertMaster('ka-only', '+995500000002', 1000, ['ka']);
  const C = await insertMaster('ru-en', '+995500000003', 1000, ['ru', 'en']);
  const D = await insertMaster('unknown', '+995500000004', 1000, []);
  const E = await insertMaster('ka-broke', '+995500000005', 0, ['ka']);
  const order1 = await newOrder('langord1');

  // Предпросмотр: «все» — как раньше; язык оставляет только тех, кто его отметил. Не указавшие язык видны отдельно.
  const all = await dispatch.preview(order1.token, 'movers', '');
  assert.deepEqual(ids(all), [A.id, B.id, C.id, D.id].sort((a, b) => a - b));
  assert.deepEqual([all.languages.all, all.languages.byLanguage.ru, all.languages.byLanguage.ka, all.languages.byLanguage.en, all.languages.none], [4, 2, 1, 1, 1]);
  assert.equal(all.alreadyReceived, 0);
  assert.deepEqual(ids(await dispatch.preview(order1.token, 'movers', '', 'ru')), [A.id, C.id]);
  assert.deepEqual(ids(await dispatch.preview(order1.token, 'movers', '', 'ka')), [B.id]);
  assert.deepEqual(ids(await dispatch.preview(order1.token, 'movers', '', 'en')), [C.id]);
  const armenian = await dispatch.preview(order1.token, 'movers', '', 'hy');
  assert.equal(armenian.count, 0);
  assert.match(dispatch.emptyReason(armenian), /говорят по-армянски/);
  await assert.rejects(dispatch.preview(order1.token, 'movers', '', 'xx'), /Некорректный язык/);
  await assert.rejects(dispatch.dispatch(order1.token, 'movers', '', null, '__proto__'), /Некорректный язык/);

  // Рассылка тем, кто говорит по-русски: платят только они, остальные ничего не получают.
  const ru = await dispatch.preview(order1.token, 'movers', '', 'ru');
  assert.equal((await go(ru, 'ru')).count, 2);
  assert.deepEqual([await balance(A), await balance(B), await balance(C), await balance(D)], [950, 1000, 950, 1000]);
  assert.deepEqual(sms.filter(s => s.context.kind === 'lead').map(s => s.phone).sort(), [A.phone, C.phone].sort());
  assert.equal(await missed(E), 0, 'не говорящий на языке рассылки не получает «упущенный лид»');
  assert.equal((await pool.query('SELECT language FROM order_dispatches WHERE order_id=$1', [order1.id])).rows[0].language, 'ru');
  await assert.rejects(go(ru, 'ru'), /уже запускалась/);
  assert.equal(await orders.recordDispatch(order1.id, 'movers', null, null, 'ru'), false, 'дубль языка отсекает база');

  // Потом тем же группе можно отправить всем: получившие второй раз не платят и не входят в число получателей.
  const rest = await dispatch.preview(order1.token, 'movers', '');
  assert.deepEqual(ids(rest), [B.id, D.id]);
  assert.equal(rest.alreadyReceived, 2);
  assert.equal(rest.alreadySent, false);
  const ruAgain = await dispatch.preview(order1.token, 'movers', '', 'ru');
  assert.equal(ruAgain.count, 0);
  assert.equal(ruAgain.alreadySent, true);
  assert.equal(dispatch.emptyReason(ruAgain), 'Все подходящие исполнители уже получили эту заявку');
  assert.equal((await go(rest, '')).count, 2);
  assert.deepEqual([await balance(A), await balance(B), await balance(C), await balance(D)], [950, 950, 950, 950]);
  for (const master of [A, B, C, D]) assert.equal(await charges(order1, master), 1);
  assert.equal(await missed(E), 1, 'при «все» тот, кому не хватило баланса, получает «упущенный лид»');
  await assert.rejects(go(rest, ''), /уже запускалась/);
  assert.deepEqual((await pool.query('SELECT language FROM order_dispatches WHERE order_id=$1 ORDER BY id', [order1.id])).rows.map(r => r.language), ['ru', '']);

  // Вторая заявка: язык, потом все. «Упущенный лид» второй раз одному и тому же исполнителю не засчитывается.
  const order2 = await newOrder('langord2');
  assert.equal((await go(await dispatch.preview(order2.token, 'movers', '', 'ka'), 'ka')).count, 1);
  assert.equal(await missed(E), 2);
  const rest2 = await dispatch.preview(order2.token, 'movers', '');
  assert.deepEqual(ids(rest2), [A.id, C.id, D.id]);
  assert.equal((await go(rest2, '')).count, 3);
  assert.equal(await missed(E), 2, 'E уже учтён при рассылке по-грузински');

  // Строки истории рассылки: язык виден, число — тех, кто говорит на нём.
  const history = await orders.getOrderDispatches(order2.id);
  assert.deepEqual(history.map(d => [d.category, d.language, d.master_count]), [['movers', 'ka', 1], ['movers', '', 3]]);

  // Telegram: кнопки категорий открывают выбор адресата, а не рассылают сразу.
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_MODERATOR_CHAT_ID = '777';
  const order3 = await newOrder('langord3');
  const main = (await telegram.buildKeyboardWithCounts(order3.token)).inline_keyboard.flat();
  assert.match(main.find(b => b.text.includes('Грузчики')).callback_data, /^pick:langord3:movers:/);
  assert.ok(!main.some(b => b.callback_data && b.callback_data.startsWith('cat:')));
  main.forEach(b => b.callback_data && assert.ok(Buffer.byteLength(b.callback_data) <= 64));

  const picker = await telegram.buildLanguageKeyboard(order3, 'movers');
  const flat = picker.inline_keyboard.flat();
  assert.match(flat[0].text, /Грузчики — кому отправить\?$/);
  assert.deepEqual(flat.slice(1).map(b => b.text), ['👥 Все (4)', '🗣 Говорят по-русски (2)', '🗣 Говорят по-грузински (1)', '🗣 Говорят по-английски (1)', '❔ Язык не указан: 1', '← К категориям']);
  assert.deepEqual(flat.slice(1, 5).map(b => b.callback_data), ['cat:langord3:movers::0:all', 'cat:langord3:movers::0:ru', 'cat:langord3:movers::0:ka', 'cat:langord3:movers::0:en']);
  assert.equal(flat.at(-1).callback_data, 'cats_refresh:langord3');
  flat.forEach(b => assert.ok(Buffer.byteLength(b.callback_data) <= 64));
  const done = (await telegram.buildLanguageKeyboard(order1, 'movers')).inline_keyboard.flat().map(b => b.text);
  assert.ok(done.includes('↩ 👥 Все · запускалась') && done.includes('↩ 🗣 Говорят по-русски · запускалась'));
  assert.ok(done.includes('🗣 Говорят по-грузински (0)'));

  calls.length = 0;
  await telegram.showLanguagePicker(order3, '777', 55, 'movers', '');
  assert.match(calls.at(-1).url, /editMessageReplyMarkup$/);
  assert.deepEqual([calls.at(-1).body.chat_id, calls.at(-1).body.message_id], ['777', 55]);
  assert.deepEqual(calls.at(-1).body.reply_markup, picker);

  // Нажатия модератора через вебхук.
  const press = async (data, chat = 777) => {
    calls.length = 0;
    const res = { sendStatus(code) { this.code = code; return this; } };
    await orderController.telegramWebhook({ headers: {}, body: { callback_query: { id: 'cb', data, from: { id: 1 }, message: { chat: { id: chat }, message_id: 55 } } } }, res);
    assert.equal(res.code, 200);
    return { edits: calls.filter(c => c.url.endsWith('editMessageReplyMarkup')).map(c => c.body), toasts: calls.filter(c => c.url.endsWith('answerCallbackQuery')).map(c => c.body.text) };
  };
  const dispatchRows = async order => (await pool.query('SELECT language FROM order_dispatches WHERE order_id=$1 ORDER BY id', [order.id])).rows.map(r => r.language);

  let out = await press('pick:langord3:movers::0');
  assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].message_id, 55);
  assert.ok(out.edits[0].reply_markup.inline_keyboard.flat().some(b => b.text.includes('Говорят по-русски')));
  assert.deepEqual(await dispatchRows(order3), [], 'выбор адресата ничего не рассылает');
  out = await press('pick:langord3:movers::0', 999);
  assert.deepEqual([out.toasts, out.edits.length], [['Нет доступа'], 0]);
  out = await press('pick:langord3:movers::5');
  assert.deepEqual([out.toasts, out.edits.length], [['Заявка закрыта или не найдена'], 0]);
  out = await press('pick_head:langord3');
  assert.match(out.toasts[0], /Выберите язык/);
  out = await press('lang_info:langord3:2');
  assert.match(out.toasts[0], /У 2 исполнителей язык не указан/);

  const before = sms.length;
  out = await press('cat:langord3:movers::0:xx');
  assert.deepEqual([out.toasts, await dispatchRows(order3), sms.length], [['Некорректный язык рассылки'], [], before]);
  out = await press('cat:langord3:movers::0:ka');
  assert.deepEqual(out.toasts, ['Запускаем рассылку…']);
  assert.deepEqual(await dispatchRows(order3), ['ka']);
  assert.equal(await charges(order3, B), 1);
  assert.equal(await charges(order3, A), 0);
  out = await press('cat:langord3:movers::0:ka');
  assert.deepEqual(out.toasts, ['Рассылка этой группе уже запускалась']);
  assert.ok(out.edits[0].reply_markup.inline_keyboard.flat().some(b => b.callback_data && b.callback_data.startsWith('pick:')), 'после отказа возвращаются категории');
  out = await press('cat:langord3:movers::0:ru');
  assert.deepEqual(await dispatchRows(order3), ['ka', 'ru']);
  out = await press('cat:langord3:movers::0:en');
  assert.deepEqual(out.toasts, ['Все подходящие исполнители уже получили эту заявку']);
  assert.equal(out.edits.length, 1);
  // Кнопка из старого сообщения (без языка) работает как раньше: всем.
  out = await press('cat:langord3:movers::0');
  assert.deepEqual(out.toasts, ['Запускаем рассылку…']);
  assert.deepEqual(await dispatchRows(order3), ['ka', 'ru', '']);
  for (const master of [A, B, C, D]) assert.equal(await charges(order3, master), 1);

  // Сообщение модератора называет язык рассылки.
  await pool.query("INSERT INTO order_moderation_messages(order_id, chat_id, message_id) VALUES($1,'777',55)", [order3.id]);
  calls.length = 0;
  await realUpdateMessage(await orders.getOrderByToken(order3.token));
  const text = calls.find(c => c.url.endsWith('editMessageText')).body.text;
  assert.match(text, /Грузчики · говорят по-грузински\nВыбрано: 1 · принято: 1/);
  assert.match(text, /Грузчики · говорят по-русски\nВыбрано: 2 · принято: 2/);

  // Форма и предпросмотр в админке.
  const ejs = require('ejs');
  const views = path.join(__dirname, '../src/views');
  const includer = (original, parsed) => (original === './_header' || original === './_footer' ? { template: '' } : { filename: parsed });
  const render = (file, data) => ejs.render(fs.readFileSync(path.join(views, file), 'utf8'), data, { filename: path.join(views, file), includer });
  const order4 = await newOrder('langord4');
  const plan = await dispatch.preview(order4.token, 'movers', '', 'ru');
  const groups = await categories.groups();
  const page = render('admin/dispatch.ejs', { token: order4.token, plan, error: null, result: null, groups, speakLabels, emptyReason: dispatch.emptyReason, csrfToken: 'csrf' });
  assert.match(page, /Кому: <strong>говорят по-русски<\/strong>/);
  assert.match(page, /name="language" value="ru"/);
  assert.match(page, /language=ka/);
  assert.match(page, /язык не указан у 1/);
  const empty = await dispatch.preview(order4.token, 'movers', '', 'hy');
  assert.match(render('admin/dispatch.ejs', { token: order4.token, plan: empty, error: null, result: null, groups, speakLabels, emptyReason: dispatch.emptyReason, csrfToken: 'csrf' }), /говорят по-армянски\. Попробуйте другого адресата/);
  const detail = render('admin/order-detail.ejs', { order: await admin.getOrderDetailAdmin(order3.token), groups, speakLabels, csrfToken: 'csrf', revisionNotice: null });
  assert.match(detail, /name="language"/);
  assert.match(detail, /Говорят по-английски/);
  assert.match(detail, /movers · говорят по-грузински/);

  console.log('PASS: dispatch by spoken language (preview, charging, widening, missed leads, Telegram picker, webhook, admin form)');
})().catch(e => { console.error(e); process.exitCode = 1; });
