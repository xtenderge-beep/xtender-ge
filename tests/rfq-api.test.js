// API заявок для ИИ-ассистентов (rfq.controller): заявка ждёт кода из SMS и только после него уходит модератору,
// как с формы на сайте. Что прислал ассистент и согласие с его слов — в журнале согласий; описание для
// моделей (/openapi.json, /llms.txt) перечисляет только услуги, у которых есть исполнители.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { newDb } = require('pg-mem');
const db = newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
const redis = new (require('ioredis-mock'))();
const sms = [], moderator = [];
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/sms.service', {
  sendOtp: async (phone, code) => { sms.push({ phone, text: 'Code: ' + code }); return { providerMessageId: 'otp' }; },
  sendOrderNotification: async (phone, text) => { sms.push({ phone, text }); return { ok: true, providerMessageId: 'sms-' + sms.length }; },
});
stub('../src/services/telegram.service', new Proxy({}, { get: (target, name) => async (...args) => { if (name === 'notifyModerator') moderator.push(args[0]); return null; } }));
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru' });
process.env.DOMAIN = 'xtender.test';
const agentApi = require('../src/config/agentApi');
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

let server;
(async () => {
  const express = require('express'), app = express(), wrap = require('../src/middleware/asyncHandler');
  const rfq = require('../src/controllers/rfq.controller');
  app.set('trust proxy', 1); app.use(express.json());
  app.post('/v1/rfq/create', wrap(rfq.create)); app.post('/v1/rfq/:rfq_id/verify', wrap(rfq.verify));
  app.get('/openapi.json', wrap(rfq.openapi)); app.get('/llms.txt', wrap(rfq.llmsTxt));
  app.use((error, req, res, next) => { console.error(error); res.status(500).json({ success: false, message: error.message }); });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChatGPT-User/1.0 test' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const logs = async (orderId) => (await pool.query('SELECT * FROM sms_consent_logs WHERE order_id=$1 ORDER BY id', [orderId])).rows;

  // 1. Описание для моделей: без исполнителей — без списка услуг; с исполнителем услуга и число появляются.
  let spec = await (await fetch(base + '/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths), ['/v1/rfq/create', '/v1/rfq/{rfq_id}/verify']);
  assert.deepEqual([spec.paths['/v1/rfq/create'].post.operationId, spec.paths['/v1/rfq/{rfq_id}/verify'].post.operationId], ['createRequest', 'verifyRequest']);
  assert.equal(spec.servers[0].url, 'https://xtender.test');
  assert.doesNotMatch(spec.components.schemas.CreateRequest.properties.category.description, /providers now/);
  // У ChatGPT описание операции — до 300 знаков.
  for (const item of Object.values(spec.paths)) assert.ok(item.post.description.length <= 300, item.post.operationId);
  let llms = await fetch(base + '/llms.txt');
  assert.match(llms.headers.get('content-type'), /^text\/plain/);
  let llmsText = await llms.text();
  assert.match(llmsText, /^# xtender\.ge\n\n> /);
  assert.ok(llmsText.includes('(https://xtender.test/openapi.json)'));
  assert.doesNotMatch(llmsText, /Services with providers now/);

  const master = (await pool.query("INSERT INTO masters(name,phone,category,is_active) VALUES('Agent Test','+995500000951','movers',true) RETURNING id")).rows[0];
  await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)", [master.id]);
  rfq._resetCatalog();
  llmsText = await (await fetch(base + '/llms.txt')).text();
  assert.match(llmsText, /## Services with providers now\n\n.+\n\n- `movers` .+: Tbilisi 1\n/);
  spec = await (await fetch(base + '/openapi.json')).json();
  assert.match(spec.components.schemas.CreateRequest.properties.category.description, /Services with providers now: .+\./);

  // 2. Проверка входа: пустой список, чужой номер, нет согласия — 400, SMS не уходит, черновика нет.
  const phone = '+995555000951';
  const request = { category: 'арматура', items: [{ name: 'Арматура d12', quantity: '2 тонны' }], details: 'Доставка завтра утром',
    district: 'Сабуртало', city: 'Тбилиси', customer_phone: '+995 555 000 951', customer_name: 'Артур', language: 'ru', terms_accepted: true, privacy_accepted: true };
  let result = await post('/v1/rfq/create', { ...request, items: [] });
  assert.deepEqual([result.status, result.body.error, result.body.field], [400, 'invalid_request', 'items']);
  result = await post('/v1/rfq/create', { ...request, items: [{ name: '???' }] });
  assert.deepEqual([result.status, result.body.field], [400, 'items']);
  result = await post('/v1/rfq/create', { ...request, customer_phone: '+79161234567' });
  assert.deepEqual([result.status, result.body.field], [400, 'customer_phone']);
  result = await post('/v1/rfq/create', { ...request, privacy_accepted: 'yes' });
  assert.deepEqual([result.status, result.body.error, result.body.field], [400, 'consent_required', 'privacy_accepted']);
  result = await post('/v1/rfq/create', { ...request, language: 'de' });
  assert.deepEqual([result.status, result.body.field], [400, 'language']);
  assert.equal(sms.length, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 0);

  // 3. Заявка создаётся неподтверждённой, номер приводится к +995..., уходит одна SMS с кодом.
  result = await post('/v1/rfq/create', request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'PENDING_VERIFICATION');
  assert.match(result.body.challenge_id, /^[a-f0-9]{48}$/);
  const rfqId = result.body.rfq_id, challengeId = result.body.challenge_id;
  let order = (await pool.query('SELECT * FROM orders WHERE token=$1', [rfqId])).rows[0];
  assert.deepEqual([order.status, order.phone, order.source, order.district_name], ['unverified', phone, agentApi.SOURCE, 'Сабуртало, Тбилиси']);
  assert.equal(order.description, 'арматура\n- Арматура d12 — 2 тонны\nДоставка завтра утром\nИмя: Артур');
  assert.equal(sms.length, 1);
  assert.equal(sms[0].phone, phone);
  assert.equal(sms[0].text, require('../src/config/service-message-copy').sms('orderCodeAssistant', { code: await redis.get('otp:order:' + phone) }));
  assert.match(sms[0].text, /^[ -~]+$/);
  assert.ok(sms[0].text.length <= 160 && !sms[0].text.includes('http'));
  const requested = (await logs(order.id)).find(row => row.event_type === 'ORDER_REQUESTED_VIA_API');
  assert.equal(requested.channel, 'api');
  assert.equal(requested.user_agent, 'ChatGPT-User/1.0 test');
  assert.ok(requested.ip_address);
  assert.deepEqual(requested.metadata.items, request.items);
  assert.equal(moderator.length, 0);

  // Новый код по той же заявке — тот же черновик, не второй.
  result = await post('/v1/rfq/create', { ...request, rfq_id: rfqId });
  assert.deepEqual([result.status, result.body.rfq_id], [200, rfqId]);
  const freshChallenge = result.body.challenge_id;
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1);

  // 4. Неверный код и код от прежней отправки не подходят; заявка всё ещё ждёт.
  const code = await redis.get('otp:order:' + phone);
  result = await post(`/v1/rfq/${rfqId}/verify`, { code: code === '1111' ? '2222' : '1111', challenge_id: freshChallenge });
  assert.deepEqual([result.status, result.body.error], [400, 'invalid_code']);
  result = await post(`/v1/rfq/${rfqId}/verify`, { code, challenge_id: challengeId });
  assert.deepEqual([result.status, result.body.error], [400, 'invalid_code']);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [order.id])).rows[0].status, 'unverified');
  result = await post('/v1/rfq/NoSuchRfq/verify', { code, challenge_id: freshChallenge });
  assert.equal(result.status, 404);

  // 5. Верный код: заявка у модератора, ссылка на страницу заявки в ответе и второй SMS, согласие записано с пометкой.
  result = await post(`/v1/rfq/${rfqId}/verify`, { code, challenge_id: freshChallenge });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  order = (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
  assert.deepEqual([result.body.status, result.body.tracking_url], ['IN_REVIEW', 'https://xtender.test/o/' + order.owner_token]);
  assert.equal(order.status, 'pending_review');
  await tick();
  assert.equal(moderator.length, 1);
  assert.equal(moderator[0].id, order.id);
  assert.ok(sms[sms.length - 1].text.includes('/o/' + order.owner_token));
  const rows = await logs(order.id);
  const verified = rows.find(row => row.event_type === 'CLIENT_CONSENT_OTP_VERIFIED');
  assert.equal(verified.consent_language, 'ru');
  assert.equal(verified.metadata.snapshot.acceptance_method, 'ai_agent_reported');
  assert.ok(rows.some(row => row.event_type === 'ORDER_PUBLISHED'));
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM consent_uses WHERE subject_role='client' AND subject_id=$1", [order.id])).rows[0].n, 1);

  // 6. Повторное подтверждение — 409, заявка не публикуется второй раз.
  result = await post(`/v1/rfq/${rfqId}/verify`, { code, challenge_id: freshChallenge });
  assert.deepEqual([result.status, result.body.error], [409, 'already_confirmed']);
  await tick();
  assert.equal(moderator.length, 1);

  console.log('rfq-api tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server && server.close());
