// Цифры на вкладках меню админки (adminNav.service): цифра горит, пока на вкладке есть
// необработанное, плюс новое с прошлого захода, которое уже обработал кто-то другой.
// Заход на вкладку помечает новое в списке; ждущее обработки в цифре остаётся.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { newDb } = require('pg-mem');
const db = newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/telegram.service', { updateMessage: async () => {}, sendToChat: async () => {}, sendSecurityAlert: async () => {} });
process.env.ADMIN_PASSWORD = 'test-only'; process.env.ADMIN_SESSION_SECRET = 'admin-nav-counts-only';
const nav = require('../src/services/adminNav.service');

const ago = minutes => new Date(Date.now() - minutes * 60000);
const DAY = 24 * 60;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const master = async (name, phone, at, active = true) => (await one(
  'INSERT INTO masters(name,phone,created_at,is_active) VALUES($1,$2,$3,$4) RETURNING id', [name, phone, at, active])).id;
const order = async (token, status, created, confirmed) => (await one(
  'INSERT INTO orders(token,owner_token,phone,description,status,created_at,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
  [token, 'own-' + token, '+995500000900', 'Заявка ' + token, status, created, confirmed])).id;
const topup = async (masterId, reference, status, at) => (await one(
  `INSERT INTO topup_requests(master_id,amount_tetri,reference,request_key,recipient,payer_name,status,created_at)
   VALUES($1,1000,$2,$2,'{}'::jsonb,'Плательщик',$3,$4) RETURNING id`, [masterId, reference, status, at])).id;
const receipt = async (masterId, topupId, at) => {
  await pool.query('INSERT INTO topup_receipts(master_id,filename,topup_id,created_at) VALUES($1,$2,$3,$4)', [masterId, 'r' + topupId + '.pdf', topupId, at]);
  await pool.query("UPDATE topup_requests SET status='received' WHERE id=$1", [topupId]);
};
const review = async (masterId, orderId, approved, at) => (await one(
  'INSERT INTO master_reviews(master_id,order_id,rating,is_approved,created_at) VALUES($1,$2,5,$3,$4) RETURNING id', [masterId, orderId, approved, at])).id;
const message = (masterId, sender, at) => pool.query(
  'INSERT INTO support_messages(master_id,sender,body,created_at) VALUES($1,$2,$3,$4)', [masterId, sender, 'Сообщение', at]);

let server;
(async () => {
  // Первый запуск: прежняя база новой не считается, но то, что в ней ждёт обработки, горит сразу.
  const oldMaster = await master('Давний', '+995500000901', ago(3 * DAY));
  const oldOrder = await order('old-order', 'closed', ago(2 * DAY), null);
  await message(oldMaster, 'master', ago(2 * DAY));
  await review(oldMaster, oldOrder, false, ago(2 * DAY));
  const oldTopup = await topup(oldMaster, 'XT-OLD', 'awaiting', ago(2 * DAY));
  assert.deepEqual(await nav.counts(), { orders: 0, masters: 0, receipts: 0, reviews: 1, support: 1 });
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM app_settings WHERE key LIKE 'admin_seen_%'")).rows[0].n, 5);

  // Дальше «прошлый заход» на каждую вкладку был час назад.
  for (const section of nav.SECTIONS) assert.deepEqual((await nav.open(section, ago(60))).fresh, []);
  await assert.rejects(() => nav.open('settings'));

  // Заявки. Новость — подтверждённый телефон, а не создание черновика. Ждёт — без рассылки.
  await order('fresh', 'pending_review', ago(30), ago(30));            // новая и ждёт
  await order('draft', 'unverified', ago(20), null);                   // черновик: ничего
  await order('late', 'pending_review', ago(3 * DAY), ago(10));        // создана давно, подтверждена сейчас
  const done = await order('done', 'closed', ago(8), ago(8));          // новая, уже обработана менеджером
  await order('stuck', 'pending_review', ago(2 * DAY), ago(2 * DAY));  // давняя, всё ещё без рассылки
  await order('revise', 'needs_revision', ago(2 * DAY), ago(2 * DAY)); // у клиента на доработке: ждёт не нас
  // Давняя заявка, которую заказчик исправил после возврата на доработку, — снова новая (один раз).
  const back = await order('back', 'pending_review', ago(2 * DAY), ago(2 * DAY));
  for (const minutes of [12, 11]) {
    await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,order_id,channel,timestamp_utc) VALUES('ORDER_RESUBMITTED','+995500000900',$1,'web',$2)", [back, ago(minutes)]);
  }
  // Исполнители. Ждёт — «На модерации»; отложенный «на уточнение» и заблокированный не ждут.
  const answered = await master('С ответом', '+995500000902', ago(3 * DAY));
  const newcomer = await master('Новичок', '+995500000903', ago(15));               // новый, уже одобрен менеджером
  const rookie = await master('Свежий', '+995500000904', ago(5), false);            // новый и ждёт
  const pending = await master('Ждущий', '+995500000905', ago(3 * DAY), false);     // давний, ждёт
  const parked = await master('Отложенный', '+995500000906', ago(3 * DAY), false);
  await pool.query('INSERT INTO admin_master_followups(master_id) VALUES($1)', [parked]);
  const banned = await master('Заблокированный', '+995500000907', ago(3 * DAY), false);
  await pool.query('UPDATE masters SET is_banned=true WHERE id=$1', [banned]);
  // Чеки. Ждёт счёт с чеком; счёт без чека — только новость; отменённый не считается.
  await receipt(oldMaster, oldTopup, ago(10));                                      // новый чек к давнему счёту
  await receipt(newcomer, await topup(newcomer, 'XT-NEW', 'awaiting', ago(10)), ago(3)); // новый счёт с чеком: один раз
  await topup(newcomer, 'XT-BARE', 'awaiting', ago(6));                             // новый счёт без чека
  await topup(newcomer, 'XT-GONE', 'cancelled', ago(5));
  const waitTopup = await topup(answered, 'XT-WAIT', 'awaiting', ago(2 * DAY));
  await receipt(answered, waitTopup, ago(2 * DAY));                                 // давний чек, не подтверждён
  // Отзывы: всё, что ждёт проверки.
  const freshReview = await review(newcomer, done, false, ago(7));
  await review(answered, done, true, ago(7));
  // Поддержка: обращение без ответа; отвеченное (в том числе из Telegram) не считается.
  await message(newcomer, 'master', ago(10));
  await message(answered, 'master', ago(10)); await message(answered, 'moderator', ago(5));

  const expected = { orders: 5, masters: 3, receipts: 4, reviews: 2, support: 2 };
  assert.deepEqual(await nav.counts(), expected);
  assert.deepEqual(await nav.counts(), expected, 'подсчёт ничего не отмечает просмотренным');

  // Цифры для страницы ставит middleware только на GET и только там, где страница рисуется.
  const middleware = require('../src/middleware/adminNavCounts');
  const run = async req => { const res = { locals: {} }; let passed = false; await middleware(req, res, () => { passed = true; }); assert.ok(passed); return res.locals.navCounts; };
  assert.deepEqual(await run({ method: 'GET', path: '/orders', query: {} }), expected);
  for (const req of [{ method: 'POST', path: '/orders/x/send', query: {} }, { method: 'GET', path: '/nav-counts', query: {} }, { method: 'GET', path: '/', query: { format: 'json' } }]) {
    assert.equal(await run(req), undefined);
  }

  const express = require('express'), app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../src/views'));
  app.use(express.urlencoded({ extended: false })); app.use(require('cookie-parser')());
  app.use('/admin', require('../src/routes/admin.routes'));
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(error.message); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookie = 'admin_session=' + require('../src/config/adminAuth').createSessionValue().cookieValue;
  const page = async url => { const response = await fetch(base + url, { headers: { cookie } }); assert.equal(response.status, 200, url); return response.text(); };
  const live = async () => { const response = await fetch(base + '/admin/nav-counts', { headers: { cookie } }); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); };
  // Цифра вкладки в шапке страницы: число, либо 0, если плашка скрыта.
  const badge = (html, section) => {
    const [, hidden, text] = html.match(new RegExp('<span class="admin-nav-badge" data-nav-count="' + section + '" title="[^"]+"( hidden)?>([^<]*)</span>'));
    return hidden ? 0 : Number(text);
  };
  const pills = (html, word) => (html.match(new RegExp('bg-amber-400 text-stone-900">' + word + '</span>', 'g')) || []).length;
  const banner = html => Number((html.match(/Новое с прошлого захода: (\d+)/) || [0, 0])[1]);

  assert.equal((await fetch(base + '/admin/nav-counts', { redirect: 'manual' })).headers.get('location'), '/admin/login');
  assert.deepEqual(await live(), expected);

  // Страница без своего списка: цифры в меню есть, ничего не отмечено.
  let html = await page('/admin/settings');
  assert.deepEqual(nav.SECTIONS.map(section => badge(html, section)), [5, 3, 4, 2, 2]);
  assert.match(html, /const initial = \{"orders":5,"masters":3,"receipts":4,"reviews":2,"support":2\};/);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new (require('vm').Script)(script[1]);
  assert.deepEqual(await live(), expected);

  // Заявки: новое перечислено сверху и помечено; обработанная менеджером из цифры уходит,
  // четыре без рассылки остаются гореть и после захода.
  html = await page('/admin/orders');
  assert.equal(badge(html, 'orders'), 4); assert.equal(badge(html, 'masters'), 3);
  assert.equal(banner(html), 4);
  for (const token of ['fresh', 'late', 'done', 'back']) assert.ok(html.includes('<a href="/admin/orders/' + token + '" class="font-bold'), token);
  assert.ok(!html.includes('<a href="/admin/orders/stuck" class="font-bold'));
  assert.equal(pills(html, 'Новая'), 4);
  assert.deepEqual(await live(), { ...expected, orders: 4 });
  html = await page('/admin/orders');
  assert.equal(banner(html), 0); assert.equal(pills(html, 'Новая'), 0); assert.equal(badge(html, 'orders'), 4);
  // Заявку разослали — цифра уменьшилась; пришла ещё одна — выросла без перезагрузки.
  await pool.query("UPDATE orders SET status='new', first_dispatched_at=NOW() WHERE token='stuck'");
  assert.deepEqual(await live(), { ...expected, orders: 3 });
  await new Promise(resolve => setTimeout(resolve, 15));
  await order('next', 'pending_review', new Date(), new Date());
  assert.deepEqual(await live(), { ...expected, orders: 4 });

  // Страница заявки у администратора идёт с шапкой менеджера — цифры есть и там.
  html = await page('/admin/orders/next');
  assert.equal(badge(html, 'orders'), 4); assert.equal(badge(html, 'masters'), 3);
  assert.match(html, /const initial = \{"orders":4,/);

  // Специалисты: список по порядку регистрации, поэтому новые ещё и ссылками сверху — даже те,
  // кого фильтр не показывает. Одобренный менеджером из цифры уходит, двое на модерации горят.
  html = await page('/admin/masters?status=active');
  assert.equal(badge(html, 'masters'), 2);
  assert.equal(banner(html), 2);
  assert.ok(html.includes('<a href="/admin/masters/' + newcomer + '" class="font-bold text-emerald-700 hover:text-emerald-800 break-words">Новичок · +995500000903</a>'));
  assert.ok(html.includes('<a href="/admin/masters/' + rookie + '" class="font-bold'));
  assert.equal(pills(html, 'Новый'), 1);
  // Отложили «на уточнение» или одобрили — больше не ждёт.
  await pool.query('INSERT INTO admin_master_followups(master_id) VALUES($1)', [pending]);
  assert.equal((await live()).masters, 1);
  await pool.query('UPDATE masters SET is_active=true WHERE id=$1', [rookie]);
  assert.equal((await live()).masters, 0);

  // Чеки: поиск показывает часть списка и ничего не отмечает. Счёт без чека после захода гаснет,
  // три счёта с чеками горят, пока оплату не подтвердили.
  html = await page('/admin/receipts?q=XT-NEW');
  assert.equal(badge(html, 'receipts'), 4); assert.equal(pills(html, 'Новое'), 0);
  html = await page('/admin/receipts');
  assert.equal(badge(html, 'receipts'), 3); assert.equal(pills(html, 'Новое'), 3);
  await require('../src/services/receipt.service').confirmPayment(waitTopup, 1000, null);
  assert.equal((await live()).receipts, 2);

  // Отзывы и поддержка: горят, пока не проверили и не ответили.
  html = await page('/admin/reviews');
  assert.equal(badge(html, 'reviews'), 2); assert.equal(pills(html, 'Новый'), 1);
  await require('../src/services/review.service').approve(freshReview);
  html = await page('/admin/support');
  assert.equal(badge(html, 'support'), 2); assert.equal(pills(html, 'Новое'), 1);
  await message(newcomer, 'moderator', new Date());
  const settled = { orders: 4, masters: 0, receipts: 2, reviews: 1, support: 1 };
  assert.deepEqual(await live(), settled);

  // Без цифр со страницей (отрисовка из POST) скрипт сам запросит их; сбой подсчёта страницу не роняет.
  const ejs = require('ejs'), file = path.join(__dirname, '../src/views/admin/_header.ejs');
  const bare = ejs.render(fs.readFileSync(file, 'utf8'), { active: 'orders', csrfToken: 'csrf' }, { filename: file });
  assert.match(bare, /const initial = null;/);
  assert.deepEqual(nav.SECTIONS.map(section => badge(bare, section)), [0, 0, 0, 0, 0]);
  const query = pool.query.bind(pool);
  pool.query = async (sql, ...args) => { if (String(sql).includes('FROM app_settings WHERE key IN')) throw new Error('settings unavailable'); return query(sql, ...args); };
  const errors = console.error; console.error = () => {};
  try {
    html = await page('/admin/orders');
    assert.match(html, /const initial = null;/); assert.equal(banner(html), 0);
    assert.equal((await fetch(base + '/admin/nav-counts', { headers: { cookie } })).status, 500);
  } finally { pool.query = query; console.error = errors; }
  assert.deepEqual(await live(), settled);

  console.log('PASS: admin menu counts — unprocessed orders, providers, receipts, reviews and support threads stay lit until handled; items handled by someone else are shown as new until the tab is opened; first run does not treat the old base as new; live endpoint; failure does not break pages');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); redis.disconnect(); });
