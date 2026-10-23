// SMS заказчику при подтверждении заявки. В первой SMS только код: со ссылкой на заявку в ней люди
// открывали страницу заявки, считали заявку отправленной и код не вводили. Ссылка уходит второй SMS
// после подтверждения — и с формы на сайте, и по ссылке менеджера.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { newDb } = require('pg-mem');
const db = newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
const redis = new (require('ioredis-mock'))();
const sms = []; let failLinkSms = false;
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/sms.service', {
  sendOtp: async (phone, code) => { sms.push({ phone, text: 'Code: ' + code, context: { otp: true } }); return { providerMessageId: 'otp' }; },
  sendOrderNotification: async (phone, text, context = {}) => {
    if (failLinkSms && text.includes('/o/')) throw Object.assign(new Error('gateway rejected'), { deliveryUnknown: false });
    sms.push({ phone, text, context }); return { ok: true, providerMessageId: 'sms-' + sms.length };
  },
});
stub('../src/services/telegram.service', new Proxy({}, { get: () => async () => null }));
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru' });
process.env.DOMAIN = 'xtender.test'; process.env.ADMIN_PASSWORD = 'test-only'; process.env.ADMIN_SESSION_SECRET = 'order-code-sms-only';
const message = require('../src/config/service-message-copy');
const consent = require('../src/services/consent.service');
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

let server;
(async () => {
  // Тексты: латиница (шлюз портит остальное), в SMS с кодом ссылки нет, обе умещаются в одну SMS.
  const codeText = message.sms('orderCode', { code: '4821' });
  const linkText = message.sms('orderLink', { id: 12345, link: 'https://xtender.ge/o/AbCdEf1234' });
  assert.equal(codeText, 'Xtender code: 4821. Enter it on the site to send your request.');
  assert.equal(linkText, 'Xtender: request #12345 is sent. Status and closing: https://xtender.ge/o/AbCdEf1234');
  for (const text of [codeText, linkText]) { assert.match(text, /^[ -~]+$/); assert.ok(text.length <= 160); assert.ok(!text.includes('{')); }
  assert.doesNotMatch(codeText, /https?:|\/o\/|#/);

  const express = require('express'), app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../src/views')); app.set('trust proxy', 1);
  app.use(express.json()); app.use(express.urlencoded({ extended: false })); app.use(require('cookie-parser')());
  const i18n = require('../src/config/i18n'), wrap = require('../src/middleware/asyncHandler');
  app.use((req, res, next) => {
    req.lang = i18n.normalizeLang(req.cookies.lang); res.locals.lang = req.lang; res.locals.t = i18n.translate(req.lang); res.locals.currentPath = req.originalUrl;
    res.locals.isRememberedProvider = false; res.locals.googleTagId = ''; res.locals.metaPixel = null; next();
  });
  app.use(require('../src/routes/crmPublic.routes'));
  app.use('/api', require('../src/routes/api.routes'));
  app.use('/admin', require('../src/routes/admin.routes'));
  app.get('/o/:ownerToken', wrap(require('../src/controllers/order.controller').showByOwnerToken));
  const publicRoutes = require('../src/routes/public.routes');
  app.use('/', publicRoutes); app.use('/:locale(ru|en)', publicRoutes);
  app.use((error, req, res, next) => { console.error(error); res.status(error.status || 500).json({ success: false, message: error.message }); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, body, cookie = '') => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const page = async (url, cookie = 'lang=ru') => { const response = await fetch(base + url, { headers: { cookie } }); assert.equal(response.status, 200, url); return response.text(); };
  const confirm = async (phone, token, challengeId) => {
    const code = await redis.get('otp:order:' + phone);
    assert.equal((await post('/api/otp/verify', { phone, code, challengeId })).status, 200);
    const form = new FormData(); form.append('phone', phone); form.append('token', token); form.append('challengeId', challengeId);
    const data = await (await fetch(base + '/api/orders', { method: 'POST', body: form })).json();
    await tick();
    return data;
  };
  const bundle = await consent.bundle('client', 'ru');
  const agreed = { termsAccepted: true, privacyAccepted: true, consentLanguage: bundle.language, consentDigest: bundle.digest };

  // 1. Форма на сайте: запрос кода — одна SMS, в ней код и что с ним делать, без ссылки и номера заявки.
  const phone = '+995555000101';
  let sent = await (await post('/api/otp/send', { phone, description: 'Перевезти диван из Сабуртало в Ваке', ...agreed })).json();
  assert.equal(sent.success, true, JSON.stringify(sent));
  let order = (await pool.query('SELECT * FROM orders WHERE token=$1', [sent.token])).rows[0];
  assert.equal(sms.length, 1);
  assert.deepEqual([sms[0].phone, sms[0].text, sms[0].context.log], [phone, message.sms('orderCode', { code: await redis.get('otp:order:' + phone) }), false]);
  assert.ok(!sms[0].text.includes(order.owner_token) && !sms[0].text.includes('http'));

  // Кто всё же откроет страницу заявки до подтверждения (ссылки из прежних SMS), не увидит «Активна».
  // Все переводы лежат в странице целиком (clientStrings), поэтому смотрим на разметку, а не на слова.
  const badge = (html, lang, key) => html.includes('rounded-full bg-' + (key === 'status_active' ? 'emerald' : 'amber') + '-500"></span>' + i18n.translate(lang)(key));
  const notice = (html, lang) => html.replace(/\s+/g, ' ').includes('text-amber-900 font-medium"> ' + i18n.translate(lang)('order_unverified_notice') + ' </div>');
  let html = await page('/o/' + order.owner_token);
  assert.ok(badge(html, 'ru', 'status_unverified') && notice(html, 'ru'));
  assert.ok(!badge(html, 'ru', 'status_active') && !html.includes('id="closeBtn"'));
  for (const lang of ['ka', 'en']) {
    html = await page('/o/' + order.owner_token + '?lang=' + lang, 'lang=' + lang);
    assert.ok(badge(html, lang, 'status_unverified') && notice(html, lang), lang);
  }

  // Код введён — заявка подтверждена, и только теперь уходит SMS со ссылкой на неё.
  let created = await confirm(phone, sent.token, sent.challengeId);
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.ownerLink, '/o/' + order.owner_token);
  assert.equal(sms.length, 2);
  assert.deepEqual(sms[1], { phone, text: 'Xtender: request #' + order.id + ' is sent. Status and closing: https://xtender.test/o/' + order.owner_token, context: { orderId: order.id, kind: 'transactional', deal: true } });
  html = await page('/o/' + order.owner_token);
  assert.ok(badge(html, 'ru', 'status_pending_review') && !notice(html, 'ru') && html.includes('id="closeBtn"'));

  // Сбой SMS со ссылкой заявку не ломает: она подтверждена, страница заявки открывается сама.
  const second = '+995555000102';
  sent = await (await post('/api/otp/send', { phone: second, description: 'Вывезти строительный мусор, 20 мешков', ...agreed })).json();
  failLinkSms = true;
  created = await confirm(second, sent.token, sent.challengeId);
  failLinkSms = false;
  assert.equal(created.success, true);
  assert.equal((await pool.query('SELECT status FROM orders WHERE token=$1', [sent.token])).rows[0].status, 'pending_review');
  assert.equal(sms.length, 3, 'ушла только SMS с кодом');

  // 2. Заявка по ссылке менеджера: те же две SMS.
  const manager = await require('../src/services/manager.service').create({ name: 'Менеджер', phone: '+995500010001' });
  const crm = require('../src/services/crm.service');
  const invitePhone = '+995555000103';
  const draft = await crm.invite(manager.id, { phone: invitePhone, kind: 'operator', description: 'Поднять пианино на третий этаж', districtName: 'Тбилиси', requestKey: crypto.randomUUID() });
  const opened = await fetch(base + '/d/' + draft.token, { headers: { cookie: 'lang=ru' } });
  const cookie = opened.headers.get('set-cookie').split(';')[0], csrf = cookie.split('=')[1];
  html = await opened.text();
  assert.match(html, /<form id="verify-form" hidden><p class="note">Код пришёл в SMS\. Введите его здесь — без кода заявка не отправится\.<\/p>/);
  const before = sms.length;
  const challenge = await (await post('/api/drafts/' + draft.token + '/send', { _csrf: csrf, description: 'Поднять пианино на третий этаж', districtName: 'Тбилиси', ...agreed }, cookie)).json();
  assert.equal(challenge.success, true, JSON.stringify(challenge));
  assert.equal(sms.length, before + 1);
  assert.equal(sms.at(-1).text, message.sms('orderCode', { code: await redis.get('otp:order:' + invitePhone) }));
  created = await confirm(invitePhone, challenge.token, challenge.challengeId);
  assert.equal(created.success, true, JSON.stringify(created));
  order = (await pool.query('SELECT * FROM orders WHERE token=$1', [challenge.token])).rows[0];
  assert.deepEqual([order.status, order.origin], ['pending_review', 'operator']);
  assert.equal(sms.length, before + 2);
  assert.equal(sms.at(-1).text, 'Xtender: request #' + order.id + ' is sent. Status and closing: https://xtender.test/o/' + order.owner_token);
  assert.equal(sms.at(-1).phone, invitePhone);

  // 3. Под полем кода в форме на сайте написано, что с ним делать, — на трёх языках.
  for (const [lang, url] of [['ka', '/?lang=ka'], ['ru', '/ru'], ['en', '/en']]) {
    html = await page(url, 'lang=' + lang);
    const hint = i18n.translate(lang)('otp_hint');
    assert.ok(hint && hint !== 'otp_hint', lang);
    assert.ok(html.includes('<p id="otp-hint" class="text-xs text-stone-600 mb-2">' + hint.replace(/'/g, '&#39;') + '</p>'), lang);
    assert.match(html, /id="code"[^>]*aria-describedby="otpSentTo otp-hint"/);
    // После запроса кода шаг с кодом возвращается на экран. Шаг с телефоном высокий (согласия,
    // галочки), при его замене страница сжимается, и на телефоне поле кода оставалось на сотни
    // пикселей выше видимой части — проверено в браузере на трёх размерах экрана (2026-10-12).
    assert.match(html, /otpStep\.classList\.remove\('hidden'\);[\s\S]{0,1400}?otpStep\.scrollIntoView\(\{ block: 'center' \}\);\s*codeInput\.focus\(\{ preventScroll: true \}\);/, lang);
    // Экран кода: на какой номер ушёл код, «ещё раз» и «изменить номер» — выход, если SMS не пришла
    // или в номере ошибка. Сами сценарии (отправка после четвёртой цифры, перезагрузка вкладки,
    // подстановка кода браузером) пройдены в браузере; здесь — что разметка и скрипт на месте.
    assert.match(html, /<p id="otpSentTo"[^>]*><\/p>/);
    assert.ok(html.includes('onclick="resendOtp()"') && html.includes('>' + i18n.translate(lang)('otp_resend') + '</button>'), lang);
    assert.ok(html.includes('onclick="changeOtpPhone()"') && html.includes('>' + i18n.translate(lang)('otp_change_phone') + '</button>'), lang);
    for (const piece of ["document.body.classList.add('otp-active')", "sessionStorage.setItem(CODE_STEP_KEY", "navigator.credentials.get({ otp: { transport: ['sms'] }", 'token: pendingOrderToken', "if (digits.length === 4 && digits !== autoSubmittedCode)"]) {
      assert.ok(html.includes(piece), lang + ': ' + piece);
    }
    for (const inline of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new (require('vm').Script)(inline[1]);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../src/styles/input.css'), 'utf8'), /body\.otp-active #post-section \{\s*position: fixed; inset: 0;/);

  // 4. «Отправить код ещё раз» и возврат к номеру: тот же номер — та же заявка, второй черновик не
  //    создаётся; другой номер или чужой token — новая.
  const third = '+995555000104';
  const count = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
  sent = await (await post('/api/otp/send', { phone: third, description: 'Перевезти шкаф', ...agreed })).json();
  const rows = await count(), firstCode = await redis.get('otp:order:' + third);
  const again = await (await post('/api/otp/send', { phone: third, description: 'Перевезти шкаф и комод', token: sent.token, ...agreed })).json();
  assert.equal(again.success, true, JSON.stringify(again));
  assert.equal(again.token, sent.token); assert.notEqual(again.challengeId, sent.challengeId);
  assert.equal(await count(), rows, 'повторный код не создаёт вторую заявку');
  assert.equal((await pool.query('SELECT description FROM orders WHERE token=$1', [sent.token])).rows[0].description, 'Перевезти шкаф и комод');
  const other = await (await post('/api/otp/send', { phone: '+995555000105', description: 'Перевезти шкаф', token: sent.token, ...agreed })).json();
  assert.notEqual(other.token, sent.token); assert.equal(await count(), rows + 1, 'другой номер — новая заявка');
  created = await confirm(third, again.token, again.challengeId);
  assert.equal(created.success, true, JSON.stringify(created));
  const reused = await (await post('/api/otp/send', { phone: third, description: 'Ещё заявка', token: sent.token, ...agreed })).json();
  assert.notEqual(reused.token, sent.token, 'подтверждённую заявку повторный запрос не трогает');
  assert.ok(firstCode);

  // 5. Служебная строка «@сайт #код» для автоподстановки — только когда включена в настройках.
  const settings = require('../src/services/settings.service'), otp = require('../src/services/otp.service');
  const codeSms = async phone => { assert.equal((await otp.sendCode(phone, 'order', 1, {})).success, true); return sms.at(-1).text; };
  assert.equal(await settings.getOrderCodeAutofill(), false, 'по умолчанию выключено');
  assert.doesNotMatch(await codeSms('+995555000106'), /@/);
  await settings.setOrderCodeAutofill(true);
  let text = await codeSms('+995555000107');
  assert.equal(text, message.sms('orderCode', { code: await redis.get('otp:order:+995555000107') }) + '\n\n@xtender.test #' + await redis.get('otp:order:+995555000107'));
  assert.ok(text.length <= 160 && /^[ -~\n]+$/.test(text));
  // Шлюз такую SMS не принял — тут же уходит обычная, код человек получает.
  const real = require('../src/services/sms.service'), original = real.sendOrderNotification;
  real.sendOrderNotification = async (phone, body, context) => { if (body.includes('@')) throw Object.assign(new Error('gateway rejected'), { code: 'SMS_NOT_ACCEPTED' }); return original(phone, body, context); };
  const quiet = console.error; console.error = () => {};
  try { text = await codeSms('+995555000108'); } finally { console.error = quiet; real.sendOrderNotification = original; }
  assert.equal(text, message.sms('orderCode', { code: await redis.get('otp:order:+995555000108') }));
  await settings.setOrderCodeAutofill(false);
  assert.doesNotMatch(await codeSms('+995555000109'), /@/);
  // Включает и выключает её администратор в настройках: кнопка с сессией и CSRF.
  const auth = require('../src/config/adminAuth'), session = auth.createSessionValue();
  const adminCookie = 'admin_session=' + session.cookieValue, csrfToken = auth.verifySessionValue(session.cookieValue).csrfToken;
  const toggle = (body, withCookie = true) => fetch(base + '/admin/settings/order-code-autofill', { method: 'POST', redirect: 'manual', headers: withCookie ? { cookie: adminCookie } : {}, body: new URLSearchParams(body) });
  html = await (await fetch(base + '/admin/settings', { headers: { cookie: adminCookie } })).text();
  assert.match(html, /@xtender\.test #1234/); assert.match(html, /Сейчас: <b class="text-stone-900">выключено<\/b>/);
  assert.match(html, /<input type="hidden" name="enabled" value="1">/);
  assert.equal((await toggle({ enabled: '1' }, false)).headers.get('location'), '/admin/login');
  assert.equal((await toggle({ enabled: '1' })).status, 403);
  assert.equal((await toggle({ _csrf: csrfToken, enabled: '1' })).headers.get('location'), '/admin/settings?saved=autofill#order-code-autofill');
  assert.equal(await settings.getOrderCodeAutofill(), true);
  html = await (await fetch(base + '/admin/settings?saved=autofill', { headers: { cookie: adminCookie } })).text();
  assert.match(html, /Сейчас: <b class="text-emerald-700">включено<\/b>/); assert.match(html, /<input type="hidden" name="enabled" value="0">/);
  await toggle({ _csrf: csrfToken, enabled: '0' });
  assert.equal(await settings.getOrderCodeAutofill(), false);

  console.log('PASS: order code SMS — the first SMS carries only the code, the request link goes in a second SMS after confirmation on both the site form and the manager link; a failed link SMS does not break the request; the unconfirmed request page no longer says it is active; the code screen has resend and change-number, a repeated code keeps the same request; the autofill line is added only when switched on and falls back to the plain SMS. No real SMS sent.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); redis.disconnect(); });
