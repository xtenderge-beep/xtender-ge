// Сделка на сайте без ChatGPT: страница согласия /consent, страница заявки заказчика /o/ и исполнителя /order/, действия
// /api/orders/<token>/deal/*, страница возврата /t/. Проверяет: исполнитель по личной ссылке только читает (писать —
// после входа), в режиме «сначала предложения» кнопок звонка нет до подтверждённого выбора, устаревшая версия при выборе
// даёт понятную ошибку, чужая кука не даёт действовать за заказчика, ссылка возврата не открывает предложений и контактов
// и не шлёт больше трёх SMS в час, заявка со звонками выглядит как раньше; три языка без сырых ключей.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DEAL_WORKER = 'manual';
const harness = require('./api-v1-harness');

const { pool, redis } = harness;
const day = 24 * 60 * 60 * 1000;
const sms = async (phone) => (await redis.lrange('sandbox:sms', 0, -1)).map((line) => JSON.parse(line)).filter((m) => m.to === phone).reverse();

(async () => {
  const express = require('express');
  const wrap = require('../src/middleware/asyncHandler');
  const i18n = require('../src/config/i18n');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../src/views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(require('cookie-parser')());
  app.use((req, res, next) => {
    req.lang = i18n.normalizeLang(req.cookies.lang);
    Object.assign(res.locals, { lang: req.lang, t: i18n.translate(req.lang), currentPath: req.originalUrl, isRememberedProvider: false, googleTagId: '', metaPixel: null });
    next();
  });
  const orderController = require('../src/controllers/order.controller');
  const dealController = require('../src/controllers/deal.controller');
  app.get('/order/:token', wrap(orderController.show));
  app.get('/o/:ownerToken', wrap(orderController.showByOwnerToken));
  app.get('/consent/:token', wrap(dealController.consentPage));
  app.post('/consent/:token', wrap(dealController.consentSubmit));
  app.get('/t/:token', wrap(dealController.resumePage));
  app.post('/t/:token/link', wrap(dealController.resumeSendLink));
  app.use('/api', require('../src/routes/api.routes'));
  app.use((error, req, res, next) => { console.error(error); res.status(500).send('error'); });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.PUBLIC_BASE_URL = base;
  const get = async (url, cookie = '') => { const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' }); return { status: r.status, html: await r.text(), headers: r.headers }; };
  const post = async (url, body, cookie = '') => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const form = async (url, fields) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); return { status: r.status, html: await r.text() }; };
  const noRawKeys = (html, where) => {
    for (const key of ['deal_open', 'mode_offers', 'offer_status_', 'reason_', 'total_incomplete', 'rule_first_offer', 'consent_title', 'resume_title']) assert.ok(!html.includes('>' + key), `${where}: raw key ${key}`);
  };

  try {
    const customerPhone = '+995599555001';
    const provider = await harness.addMaster({ phone: '+995599666001', name: 'Dato Movers' });
    const account = await require('../src/services/account.service').ensureForVerifiedPhone(customerPhone);
    const tenders = require('../src/services/tender.service');
    const draft = await tenders.createDraft(account, { title: 'Move a fridge', description: 'Second floor, lift works.', language: 'ru', category_ids: ['movers'],
      location: { city_id: 'city:tbilisi', private_address: 'Rustaveli 5' }, requested_start_at: new Date(Date.now() + 3 * day).toISOString() }, { channel: 'chatgpt' });

    // 1. Согласие: страница с текстами Оферты и Политики, без галочек — отказ, с ними — принято (и SMS).
    let consentUrl;
    try { await tenders.publish(account, tenders.apiId(draft), draft.api_version); } catch (error) { consentUrl = error.details.consent_url; }
    const consentPath = new URL(consentUrl).pathname;
    for (const lang of ['ka', 'ru', 'en']) {
      const page = await get(consentPath + '?lang=' + lang);
      assert.equal(page.status, 200);
      assert.ok(page.html.includes(`<html lang="${lang}"`));
      assert.ok(page.html.includes('name="terms"') && page.html.includes('name="sms"'));
      noRawKeys(page.html, 'consent ' + lang);
    }
    const digest = /name="digest" value="([a-f0-9]+)"/.exec((await get(consentPath + '?lang=ru')).html)[1];
    assert.equal((await form(consentPath, { digest, lang: 'ru', terms: '1' })).status, 400, 'both boxes are required');
    assert.equal((await form(consentPath, { digest: 'stale', lang: 'ru', terms: '1', privacy: '1' })).status, 409, 'the text changed while the page was open');
    const accepted = await form(consentPath, { digest, lang: 'ru', terms: '1', privacy: '1', sms: '1' });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.html.includes('Вернитесь в ChatGPT'));
    assert.equal((await get(consentPath)).status, 404, 'the link works once');
    const rows = (await pool.query("SELECT event_type, consent_language, terms_version FROM sms_consent_logs WHERE phone_number=$1 ORDER BY id", [customerPhone])).rows;
    assert.deepEqual(rows.map((r) => r.event_type), ['CLIENT_CONSENT_ACCOUNT', 'NOTIFY_SMS_CONSENT']);
    assert.equal(rows[0].consent_language, 'ru');

    // Публикация и рассылка модератором.
    const fresh = (await pool.query('SELECT * FROM orders WHERE id=$1', [draft.id])).rows[0];
    await tenders.publish(await require('../src/services/account.service').getById(account.id), tenders.apiId(fresh), fresh.api_version);
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [draft.id])).rows[0];
    const dispatch = require('../src/services/dispatch.service');
    const plan = await dispatch.preview(order.token, 'movers', '');
    await dispatch.dispatch(order.token, 'movers', '', { price: plan.price, count: plan.count, revision: 0 });

    // 2. Заказчик открывает страницу из SMS: сбор идёт, предложений нет, прежней кнопки закрытия нет.
    const ownerVisit = await get('/o/' + order.owner_token);
    const ownerCookie = ownerVisit.headers.get('set-cookie').split(',').map((c) => c.split(';')[0].trim()).filter((c) => c.startsWith('order_')).join('; ');
    const ownerPage = async (lang = 'ru') => get('/order/' + order.token, `${ownerCookie}; lang=${lang}; olang_${order.token}=${lang}`);
    let owner = await ownerPage();
    assert.ok(owner.html.includes('id="deal"'));
    assert.ok(owner.html.includes('Идёт сбор предложений'));
    assert.ok(owner.html.includes('Предложений пока нет'));
    assert.ok(!owner.html.includes('id="closeBtn"'), 'the deal replaces the old close button');

    // 3. Исполнитель по личной ссылке из SMS: читает, но писать нельзя; звонка в режиме предложений нет.
    const leadSms = (await sms(provider.phone)).find((m) => m.text.includes('/order/'));
    const leadPath = new URL(leadSms.text.match(/https?:\/\/\S+/)[0]).pathname + new URL(leadSms.text.match(/https?:\/\/\S+/)[0]).search;
    let viaLink = await get(leadPath);
    assert.equal(viaLink.status, 200);
    assert.ok(viaLink.html.includes('Заказчик просит письменные предложения') || viaLink.html.includes('დამკვეთი წერილობით'));
    assert.ok(!viaLink.html.includes('id="callBtn"'), 'no call button before a confirmed selection');
    assert.ok(!viaLink.html.includes('data-deal-action="offer"'), 'no offer form without sign-in');
    assert.ok(!viaLink.html.includes('Rustaveli 5') && !viaLink.html.includes('599555001'));
    assert.equal((await post(`/api/orders/${order.token}/deal/offer`, { work_price: '100' })).status, 401, 'a forwarded link cannot write');

    // Вход исполнителя (кабинет): форма предложения и вопрос.
    const sessionId = crypto.randomBytes(32).toString('hex');
    await redis.set('master_session:' + sessionId, provider.master_token);
    const providerCookie = `master_session=${sessionId}; lang=ru`;
    let mine = await get('/order/' + order.token, providerCookie);
    assert.ok(mine.html.includes('data-deal-action="offer"'));
    const sent = await post(`/api/orders/${order.token}/deal/offer`, { lang: 'ru', pricing_type: 'fixed', work_name: 'Two movers', work_price: '150', start_at: new Date(Date.now() + 3 * day).toISOString().slice(0, 16), payment_text: 'Cash' }, providerCookie);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const wrong = await post(`/api/orders/${order.token}/deal/offer`, { lang: 'ru', work_price: '15,5,5' }, providerCookie);
    assert.equal(wrong.status, 422);
    assert.equal(wrong.json.message, 'Проверьте заполнение полей.');
    assert.equal((await post(`/api/orders/${order.token}/deal/message`, { lang: 'ru', text: 'Есть ли парковка у дома?' }, providerCookie)).status, 200);
    mine = await get('/order/' + order.token, providerCookie);
    assert.ok(mine.html.includes('Ваше предложение') && mine.html.includes('150 ₾'));
    assert.ok(mine.html.includes('Есть ли парковка у дома?'));
    // Форма — только JSON: обычная отправка формы с чужого сайта не проходит.
    assert.equal((await fetch(`${base}/api/orders/${order.token}/deal/offer`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: providerCookie }, body: 'work_price=1' })).status, 415);

    // 4. Заказчик: предложение и вопрос видны, ответ; без куки владельца действия запрещены.
    owner = await ownerPage();
    assert.ok(owner.html.includes('150 ₾') && owner.html.includes('Dato Movers'));
    assert.ok(owner.html.includes('Есть ли парковка у дома?'));
    const threadId = /name="thread_id" value="([^"]+)"/.exec(owner.html)[1];
    assert.equal((await post(`/api/orders/${order.token}/deal/reply`, { thread_id: threadId, text: 'Да, во дворе.' })).status, 403, 'no owner cookie');
    assert.equal((await post(`/api/orders/${order.token}/deal/reply`, { thread_id: threadId, text: 'Да, во дворе.' }, ownerCookie)).status, 200);
    const offerId = /name="offer_id" value="([^"]+)"/.exec(owner.html)[1];
    const offerVersion = /name="offer_version" value="(\d+)"/.exec(owner.html)[1];
    const tenderVersion = Number(/name="tender_version" value="(\d+)"/.exec(owner.html)[1]);
    const stale = await post(`/api/orders/${order.token}/deal/select`, { lang: 'ru', offer_id: offerId, offer_version: offerVersion, tender_version: tenderVersion - 1 }, ownerCookie);
    assert.equal(stale.status, 412);
    assert.match(stale.json.message, /Обновите страницу/);
    assert.equal((await post(`/api/orders/${order.token}/deal/select`, { lang: 'ru', offer_id: offerId, offer_version: offerVersion, tender_version: tenderVersion }, ownerCookie)).status, 200);
    owner = await ownerPage();
    assert.ok(owner.html.includes('Ждём подтверждения'));
    assert.ok(!owner.html.includes('Телефон исполнителя'));

    // 5. Исполнитель подтверждает: телефон заказчика и адрес открыты, кнопка звонка появилась.
    mine = await get('/order/' + order.token, providerCookie);
    assert.ok(mine.html.includes('Заказчик выбрал ваше предложение'));
    assert.equal((await post(`/api/orders/${order.token}/deal/accept`, { lang: 'ru' }, providerCookie)).status, 200);
    mine = await get('/order/' + order.token, providerCookie);
    assert.ok(mine.html.includes('+995599555001') && mine.html.includes('Rustaveli 5'));
    assert.ok(mine.html.includes('id="callBtn"'));
    owner = await ownerPage();
    assert.ok(owner.html.includes('Телефон исполнителя') && owner.html.includes(provider.phone));

    // 6. Три языка: страницы заказчика и исполнителя без сырых ключей.
    for (const lang of ['ka', 'ru', 'en']) {
      const ownerLang = await ownerPage(lang);
      assert.ok(ownerLang.html.includes(`<html lang="${lang}"`), 'owner ' + lang);
      noRawKeys(ownerLang.html, 'owner ' + lang);
      const providerLang = await get('/order/' + order.token, `master_session=${sessionId}; lang=${lang}`);
      noRawKeys(providerLang.html, 'provider ' + lang);
    }
    // Завершение.
    const version = (await pool.query('SELECT api_version FROM orders WHERE id=$1', [order.id])).rows[0].api_version;
    assert.equal((await post(`/api/orders/${order.token}/deal/complete`, { version }, ownerCookie)).status, 200);
    assert.equal((await pool.query('SELECT deal_status, status FROM orders WHERE id=$1', [order.id])).rows[0].deal_status, 'completed');

    // 7. Ссылка возврата: номер и состояние, без предложений, контактов и переписки; SMS со ссылкой — не больше трёх в час.
    const resume = await require('../src/services/resumeLink.service').create(order.id);
    const resumePath = new URL(resume.url).pathname;
    for (const lang of ['ka', 'ru', 'en']) {
      const page = await get(resumePath + '?lang=' + lang);
      assert.equal(page.status, 200);
      noRawKeys(page.html, 'resume ' + lang);
      assert.ok(!page.html.includes('150') && !page.html.includes(provider.phone) && !page.html.includes('парковка') && !page.html.includes(order.owner_token));
      assert.ok(page.html.includes('chatgpt.com/?q='));
    }
    const before = (await sms(customerPhone)).filter((m) => m.text.includes('/o/' + order.owner_token)).length;
    for (let i = 0; i < 3; i += 1) assert.equal((await form(resumePath + '/link', { lang: 'ru' })).status, 200);
    assert.equal((await form(resumePath + '/link', { lang: 'ru' })).status, 429);
    assert.equal((await sms(customerPhone)).filter((m) => m.text.includes('/o/' + order.owner_token)).length, before + 3);
    assert.equal((await get('/t/' + 'x'.repeat(32))).status, 404);

    // 8. Заявка со звонками (как раньше): блока сделки нет, кнопка закрытия на месте; действия сделки — 404.
    const calls = (await pool.query("INSERT INTO orders (token, owner_token, phone, description, status, target_categories, first_dispatched_at) VALUES ('calls-1','calls-1-owner','+995599555002','Перевезти шкаф','new',$1,NOW()) RETURNING *", [['movers']])).rows[0];
    const callsOwner = await get('/o/' + calls.owner_token);
    assert.ok(!callsOwner.html.includes('id="deal"'));
    assert.ok(callsOwner.html.includes('id="closeBtn"'));
    assert.equal((await post('/api/orders/calls-1/deal/offer', { work_price: '1' }, providerCookie)).status, 404);
    process.stdout.write('deal site tests passed\n');
  } finally {
    server.close();
  }
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
