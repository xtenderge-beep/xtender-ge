// Источники заявок (/admin/sources, trafficSource.service): площадка получает ссылку /go/<code>,
// форма заявки записывает, откуда человек пришёл, таблица сводит визиты и заявки по источникам.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const { newDb } = require('pg-mem');
const db = newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/telegram.service', new Proxy({}, { get: () => async () => null }));
stub('../src/services/sms.service', { sendOrderNotification: async () => ({ providerMessageId: 'test' }), sendOtp: async () => ({ providerMessageId: 'test' }) });
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru' });
process.env.ADMIN_PASSWORD = 'test-only'; process.env.ADMIN_SESSION_SECRET = 'traffic-sources-only'; process.env.DOMAIN = 'xtender.test';
const sources = require('../src/services/trafficSource.service');
const dashboard = require('../src/services/dashboard.service');

// Одна загрузка страницы во вкладке: скрипт посещаемости запоминает источник входа.
const script = fs.readFileSync(path.join(__dirname, '../public/js/visit.js'), 'utf8');
function tab() {
  const store = new Map();
  const sessionStorage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  return (url, referrer = '') => {
    const location = new URL(url);
    const window = {};
    vm.runInNewContext(script, { window, sessionStorage, location, URL, URLSearchParams, JSON, String, document: { referrer, documentElement: { lang: 'ru' } },
      navigator: { webdriver: true }, localStorage: { getItem: () => null } });
    return { ...window.xtEntry() };
  };
}

const ago = minutes => new Date(Date.now() - minutes * 60000);
let server;
(async () => {
  // Источник входа живёт всю вкладку: метка ссылки, иначе сайт, с которого пришли (без пути).
  let open = tab();
  assert.deepEqual(open('https://xtender.ge/?utm_source=gruppa-x&utm_medium=social', 'https://www.facebook.com/groups/1/posts/2'), { us: 'gruppa-x', r: 'https://www.facebook.com' });
  assert.deepEqual(open('https://xtender.ge/ru', 'https://xtender.ge/?utm_source=gruppa-x'), { us: 'gruppa-x', r: 'https://www.facebook.com' }, 'смена языка источник не теряет');
  assert.deepEqual(open('https://xtender.ge/ru?utm_source=drugaya', ''), { us: 'drugaya', r: '' }, 'новая метка заменяет прежнюю');
  open = tab();
  assert.deepEqual(open('https://xtender.ge/', ''), { us: '', r: '' });
  assert.deepEqual(open('https://xtender.ge/s/gruz', 'https://xtender.ge/'), { us: '', r: '' });
  assert.deepEqual(open('https://xtender.ge/', 'https://www.google.com/search?q=x'), { us: '', r: 'https://www.google.com' }, 'после прямого захода пришли с поиска');
  assert.deepEqual(open('https://xtender.ge/ru', 'https://t.me/x'), { us: '', r: 'https://www.google.com' }, 'первый внешний вход остаётся');

  // Код ссылки — название латиницей.
  assert.equal(sources.codeFrom('Группа «Переезды Тбилиси» в Facebook'), 'gruppa-pereezdy-tbilisi-v-facebook');
  assert.equal(sources.codeFrom('თბილისის ჯგუფი'), 'tbilisis-jgupi');
  assert.equal(sources.codeFrom('№ 1 !!!'), '1');
  assert.equal(sources.codeFrom('«»'), 'source');
  assert.ok(sources.codeFrom('очень длинное название площадки '.repeat(6)).length <= 40);

  const pages = await sources.pageOptions();
  assert.deepEqual(pages[0], { path: '/', label: 'Главная', languages: ['ka', 'ru', 'en'] });
  const landing = pages.find(page => page.path.startsWith('/s/'));
  assert.ok(landing, 'включённые страницы задач есть в списке');

  const fb = await sources.create({ name: '  Группа  «Переезды» в Facebook ', path: '/', lang: 'ru' });
  assert.deepEqual([fb.code, fb.name, fb.path, fb.lang], ['gruppa-pereezdy-v-facebook', 'Группа «Переезды» в Facebook', '/', 'ru']);
  assert.equal((await sources.create({ name: 'Группа «Переезды» в Facebook', path: '/', lang: 'ka' })).code, 'gruppa-pereezdy-v-facebook-2');
  const tg = await sources.create({ name: 'Telegram чат', path: landing.path, lang: landing.languages[0] });
  for (const bad of [{ name: 'x', path: '/', lang: 'ru' }, { name: 'Форум', path: '/admin', lang: 'ru' }, { name: 'Форум', path: '/', lang: 'de' }]) {
    await assert.rejects(() => sources.create(bad), { status: 400 });
  }

  // Ссылка площадки ведёт на свою страницу с меткой; неизвестный код — на главную, мусор — без метки.
  assert.equal(await sources.target(fb.code), '/ru?utm_source=gruppa-pereezdy-v-facebook&utm_medium=social');
  assert.equal(await sources.target('GRUPPA-PEREEZDY-V-FACEBOOK-2'), '/?utm_source=gruppa-pereezdy-v-facebook-2&utm_medium=social');
  assert.equal(await sources.target(tg.code), (landing.languages[0] === 'ka' ? '' : '/' + landing.languages[0]) + landing.path + '?utm_source=telegram-chat&utm_medium=social');
  assert.equal(await sources.target('staraya-ssylka'), '/?utm_source=staraya-ssylka&utm_medium=social');
  for (const junk of ['a b', '../x', '', 'x'.repeat(61), '-x']) assert.equal(await sources.target(junk), '/');

  const express = require('express'), app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../src/views')); app.set('trust proxy', 1);
  app.use(express.json()); app.use(express.urlencoded({ extended: false })); app.use(require('cookie-parser')());
  const i18n = require('../src/config/i18n');
  app.use((req, res, next) => { req.lang = 'ru'; res.locals.lang = 'ru'; res.locals.t = i18n.translate('ru'); res.locals.currentPath = req.path; next(); });
  app.use('/api', require('../src/routes/api.routes'));
  app.use('/admin', require('../src/routes/admin.routes'));
  app.use('/', require('../src/routes/public.routes'));
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(error.message); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = require('../src/config/adminAuth'), session = auth.createSessionValue();
  const cookie = 'admin_session=' + session.cookieValue, csrf = auth.verifySessionValue(session.cookieValue).csrfToken;
  const json = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'xtender.test', 'X-Forwarded-For': '203.0.113.' + (1 + Math.floor(Math.random() * 200)) }, body: JSON.stringify(body) });

  let response = await fetch(base + '/go/' + fb.code, { redirect: 'manual' });
  assert.deepEqual([response.status, response.headers.get('location'), response.headers.get('cache-control')], [302, '/ru?utm_source=gruppa-pereezdy-v-facebook&utm_medium=social', 'no-store']);

  // Форма заявки присылает источник входа — он записывается в заявку ещё до подтверждения телефона.
  const consent = await require('../src/services/consent.service').bundle('client', 'ru');
  let phones = 0;
  const draft = async entry => {
    const phone = '+9955550001' + String(10 + phones++);
    const body = { phone, description: 'Перевезти диван из Сабуртало в Ваке', termsAccepted: true, privacyAccepted: true, consentLanguage: consent.language, consentDigest: consent.digest };
    if (entry !== undefined) body.entry = entry;
    const data = await (await json('/api/otp/send', body)).json();
    assert.equal(data.success, true, JSON.stringify(data));
    return { phone, ...data, source: (await pool.query('SELECT source FROM orders WHERE token=$1', [data.token])).rows[0].source };
  };
  const placed = await draft({ us: 'gruppa-pereezdy-v-facebook', r: 'https://www.facebook.com' });
  assert.equal(placed.source, 'gruppa-pereezdy-v-facebook', 'метка важнее сайта-источника');
  assert.equal((await draft({ us: '', r: 'https://www.google.com' })).source, 'Google');
  assert.equal((await draft({ us: ' Ruchnaya_Metka ', r: '' })).source, 'ruchnaya_metka');
  assert.equal((await draft({ us: '', r: '' })).source, '', 'прямой заход');
  assert.equal((await draft({ us: '', r: 'https://www.xtender.test' })).source, '', 'свой сайт — не источник');
  assert.equal((await draft({ us: 'x'.repeat(200), r: '' })).source.length, 80);
  assert.equal((await draft(undefined)).source, null, 'форма источник не прислала');
  assert.equal((await draft('gruppa')).source, null);

  // Заказчик подтверждает телефон — заявка с источником доходит до модерации.
  const code = await redis.get('otp:order:' + placed.phone);
  assert.equal((await (await json('/api/otp/verify', { phone: placed.phone, code, challengeId: placed.challengeId })).json()).success, true);
  const form = new FormData(); form.append('phone', placed.phone); form.append('token', placed.token); form.append('challengeId', placed.challengeId);
  const activated = await (await fetch(base + '/api/orders', { method: 'POST', body: form })).json();
  assert.equal(activated.success, true, JSON.stringify(activated));
  const live = (await pool.query('SELECT id, status, source FROM orders WHERE token=$1', [placed.token])).rows[0];
  assert.deepEqual([live.status, live.source], ['pending_review', 'gruppa-pereezdy-v-facebook']);

  // Таблица за период. Остальные заявки и визиты кладём напрямую.
  const order = async (token, source, extra = {}) => (await pool.query(
    `INSERT INTO orders(token,owner_token,phone,description,status,source,origin,is_technical,first_dispatched_at,created_at,confirmed_at)
     VALUES($1,$2,'+995555000199','Заявка',$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
    [token, 'own-' + token, extra.status || 'new', source, extra.origin || 'self', Boolean(extra.technical), extra.dispatched === false ? null : ago(50), extra.at || ago(60)])).rows[0].id;
  const provider = (await pool.query("INSERT INTO masters(name,phone) VALUES('Исполнитель','+995555000300') RETURNING id")).rows[0].id;
  const contact = id => pool.query("INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,'call')", [id, provider]);
  await contact(await order('fb-1', fb.code));                                    // разослана, с контактом
  await order('fb-2', fb.code, { dispatched: false, status: 'pending_review' });   // ждёт рассылки
  await order('fb-test', fb.code, { technical: true });                            // тестовая — отдельно
  await order('fb-old', fb.code, { at: ago(40 * 24 * 60) });                       // вне периода
  await order('fb-draft', fb.code, { status: 'unverified' });                      // телефон не подтверждён
  await contact(await order('g-1', 'Google'));
  await order('raw-1', 'ruchnaya_metka', { dispatched: false, status: 'pending_review' });
  await order('direct-1', '');
  await order('old-1', null);
  await order('mgr-1', null, { origin: 'operator' });
  const visit = (visitor, source, at, staff = false) => pool.query(
    "INSERT INTO site_visits(visitor,page,source,device,browser,is_staff,created_at) VALUES($1,'home',$2,'mobile','Chrome',$3,$4)", [visitor, source, staff, at]);
  await visit('a'.repeat(16), fb.code, ago(90)); await visit('a'.repeat(16), null, ago(88)); // один визит, две страницы
  await visit('b'.repeat(16), fb.code, ago(30));
  await visit('c'.repeat(16), fb.code, ago(20), true);                                       // сотрудник
  await visit('d'.repeat(16), 'Google', ago(70));
  await visit('e'.repeat(16), null, ago(60));
  await visit('f'.repeat(16), 'staraya-ssylka', ago(10));

  const report = await sources.report(dashboard.windowFor('30'));
  const numbers = row => [row.visits, row.orders, row.dispatched, row.contacted, row.tests];
  assert.deepEqual(report.placements.map(row => row.source.code).sort(), ['gruppa-pereezdy-v-facebook', 'gruppa-pereezdy-v-facebook-2', 'telegram-chat']);
  assert.deepEqual(numbers(report.placements.find(row => row.source.code === fb.code)), [2, 3, 1, 1, 1]);
  assert.deepEqual(numbers(report.placements.find(row => row.source.code === tg.code)), [0, 0, 0, 0, 0], 'площадка без переходов видна с нулями');
  const other = name => numbers(report.others.find(row => row.name === name));
  assert.deepEqual(other('Google'), [1, 1, 1, 1, 0]);
  assert.deepEqual(other('ruchnaya_metka'), [null, 1, 0, 0, 0], 'метка, поставленная вручную, видна под своим кодом');
  assert.deepEqual(other('Прямой заход'), [1, 1, 1, 0, 0]);
  assert.deepEqual(other('staraya-ssylka'), [1, 0, 0, 0, 0]);
  assert.deepEqual(other('Источник не записан'), [null, 1, 1, 0, 0]);
  assert.deepEqual(other('Оформлены менеджером или оператором'), [null, 1, 1, 0, 0]);
  assert.equal(report.others[0].orders, 1);
  // Период меняет числа: за 90 дней в счёт входит и заявка сорокадневной давности. Проверяем не
  // «сегодня»: после полуночи по Тбилиси заявки часовой давности уже вчерашние.
  const wider = period => sources.report(dashboard.windowFor(period)).then(result => numbers(result.placements.find(row => row.source.code === fb.code)));
  assert.deepEqual(await wider('7'), [2, 3, 1, 1, 1]);
  assert.deepEqual(await wider('90'), [2, 4, 2, 1, 1]);

  // Админка: страница, создание, переименование, удаление — только с сессией и CSRF.
  const post = (url, body, withCsrf = true) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(withCsrf ? { _csrf: csrf, ...body } : body) });
  assert.equal((await fetch(base + '/admin/sources', { redirect: 'manual' })).headers.get('location'), '/admin/login');
  assert.equal((await post('/admin/sources', { name: 'Форум', path: '/', lang: 'ru' }, false)).status, 403);
  let html = await (await fetch(base + '/admin/sources', { headers: { cookie } })).text();
  assert.match(html, /<a href="\/admin\/sources" class="admin-nav-link[^"]*active[^"]*">Источники<\/a>/);
  assert.ok(html.includes('value="https://xtender.test/go/gruppa-pereezdy-v-facebook"'));
  assert.ok(html.includes('href="/ru?utm_source=gruppa-pereezdy-v-facebook&amp;utm_medium=social"'));
  assert.match(html, /\+ 1 тест\./);
  assert.match(html, /Остальные источники[\s\S]*Google[\s\S]*ruchnaya_metka/);
  for (const inline of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(inline[1]);
  response = await post('/admin/sources', { name: 'Форум <b>forum.ge</b>', path: '/', lang: 'en' });
  assert.equal(response.headers.get('location'), '/admin/sources?created=forum-b-forum-ge-b');
  html = await (await fetch(base + response.headers.get('location'), { headers: { cookie } })).text();
  assert.ok(html.includes('Форум &lt;b&gt;forum.ge&lt;/b&gt;') && !html.includes('<b>forum.ge</b>'));
  assert.match(html, /<article id="source-forum-b-forum-ge-b" class="[^"]*bg-emerald-50[^"]*">/);
  response = await post('/admin/sources', { name: 'Telegram', path: landing.path, lang: 'xx' });
  assert.equal(response.status, 302, 'незнакомый язык заменяется грузинским');
  response = await post('/admin/sources', { name: 'F', path: '/', lang: 'ru' });
  assert.equal(response.status, 400); assert.match(await response.text(), /role="alert"[^>]*>Назовите площадку/);
  const forum = (await pool.query("SELECT id FROM traffic_sources WHERE code='forum-b-forum-ge-b'")).rows[0].id;
  assert.equal((await post('/admin/sources/' + forum + '/name', { name: 'Форум forum.ge' })).headers.get('location'), '/admin/sources?renamed=1');
  assert.deepEqual((await pool.query('SELECT name, code FROM traffic_sources WHERE id=$1', [forum])).rows[0], { name: 'Форум forum.ge', code: 'forum-b-forum-ge-b' });
  assert.equal((await post('/admin/sources/999999/name', { name: 'Нет такой' })).status, 404);
  assert.equal((await post('/admin/sources/' + forum + '/delete', {})).headers.get('location'), '/admin/sources?removed=1');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM traffic_sources WHERE id=$1', [forum])).rows[0].n, 0);
  assert.equal(await sources.target('forum-b-forum-ge-b'), '/?utm_source=forum-b-forum-ge-b&utm_medium=social', 'ссылка удалённой площадки не тупик');

  // Источник виден у заявки: в списке и на её странице.
  html = await (await fetch(base + '/admin/orders', { headers: { cookie } })).text();
  assert.match(html, /источник: Группа «Переезды» в Facebook<\/span>/);
  assert.match(html, /источник: Google<\/span>/); assert.match(html, /источник: Прямой заход<\/span>/);
  html = await (await fetch(base + '/admin/orders/' + placed.token, { headers: { cookie } })).text();
  assert.match(html, /Источник: <strong>Группа «Переезды» в Facebook<\/strong>/);
  html = await (await fetch(base + '/admin/orders/old-1', { headers: { cookie } })).text();
  assert.doesNotMatch(html, /Источник: <strong>/);

  console.log('PASS: traffic sources — placement link with a readable code, entry source kept across the tab and saved on the order, report of visits, orders, dispatched and contacted per source, test orders apart, admin page with CSRF, source shown on orders');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); redis.disconnect(); });
