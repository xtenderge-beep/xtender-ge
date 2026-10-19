// MCP-сервер для ИИ-ассистентов (controllers/mcp.controller.js, POST /mcp). Подключается настоящим клиентом MCP, как
// ChatGPT или Claude: инструкция сервера, два инструмента только на чтение, список услуг с исполнителями, ссылка на
// готовую заявку — и что эта ссылка открывает на сайте ту же заявку. Сервер ничего не записывает в базу.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { newDb } = require('pg-mem');

process.env.DOMAIN = 'xtender.test';
const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (name, exports) => (require.cache[require.resolve(name)] = { exports });
stub('../src/config/db', pool);
stub('../src/config/redis', new (require('ioredis-mock'))());
stub('../src/services/sms.service', { sendOtp: async () => ({}), sendOrderNotification: async () => ({ ok: true }) });
stub('../src/services/telegram.service', new Proxy({}, { get: () => async () => null }));
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: s => /[ა-ჰ]/.test(s) ? 'ka' : /[а-яё]/i.test(s) ? 'ru' : 'en' });

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const draftLink = require('../src/config/draftLink');
const { translate, normalizeLang } = require('../src/config/i18n');
const root = path.join(__dirname, '..');

let phones = 0;
async function insertMaster(service, city = 'tbilisi') {
  const phone = '+9955003' + String(10000 + ++phones);
  const master = (await pool.query(
    `INSERT INTO masters(name,phone,category,is_active,is_subscribed,balance_tetri,master_token,city_id)
     VALUES($1,$2,$3,true,true,1000,$4,(SELECT id FROM cities WHERE slug=$5)) RETURNING *`,
    ['Giorgi ' + phones, phone, service === 'van' ? 'transport' : service, 'token-' + phone, city])).rows[0];
  await pool.query('INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,$2,$3::jsonb,true)',
    [master.id, service, JSON.stringify(service === 'van' ? { size: 'L', body: 'closed' } : {})]);
  await pool.query("INSERT INTO master_cities(master_id, city_id) VALUES ($1, (SELECT id FROM cities WHERE slug=$2))", [master.id, city]);
}

function startSite() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'src/views'));
  app.use((req, res, next) => {
    req.lang = normalizeLang(req.cookies.lang);
    Object.assign(res.locals, { lang: req.lang, currentPath: req.originalUrl, t: translate(req.lang), isRememberedProvider: false, googleTagId: '' });
    next();
  });
  const wrap = require('../src/middleware/asyncHandler');
  const mcp = require('../src/controllers/mcp.controller');
  app.post('/mcp', wrap(mcp.handle));
  app.get('/mcp', mcp.notAllowed);
  const publicRoutes = require('../src/routes/public.routes');
  app.use('/', publicRoutes);
  app.use('/:locale(ru|en)', publicRoutes);
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(String(error.stack)); });
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}

(async () => {
  await insertMaster('movers'); await insertMaster('movers'); await insertMaster('van');
  const server = await startSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'xtender-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));

    // 1. Сервер называет себя и говорит ассистенту, что делать: ссылку полным адресом, номер в чате не спрашивать.
    assert.equal(client.getServerVersion().name, 'xtender');
    const instructions = client.getInstructions();
    assert.match(instructions, /create_request_link/);
    assert.match(instructions, /full address on its own line/);
    assert.match(instructions, /Do not ask for the phone number in the chat/);

    // 2. Два инструмента, оба только читают (так их видят каталоги ChatGPT и Claude).
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['create_request_link', 'list_services']);
    for (const tool of tools) {
      assert.deepEqual([tool.annotations.readOnlyHint, tool.annotations.destructiveHint], [true, false], tool.name);
      assert.ok(tool.title && tool.description, tool.name);
    }
    const create = tools.find(tool => tool.name === 'create_request_link');
    assert.deepEqual(create.inputSchema.required, ['lang']);
    assert.deepEqual(create.inputSchema.properties.lang.enum, ['ka', 'ru', 'en']);
    assert.ok(!('phone' in create.inputSchema.properties), 'номер телефона инструмент не принимает');

    // 3. Услуги — только с исполнителями, с кодами и названиями на трёх языках.
    let result = await client.callTool({ name: 'list_services', arguments: {} });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /- movers: Movers \/ Грузчики \/ მუშები — providers: Tbilisi 2/);
    assert.match(result.content[0].text, /- van: Transport \/ Перевозки \/ გადაზიდვა — providers: Tbilisi 1/);
    assert.doesNotMatch(result.content[0].text, /\btow\b/);
    assert.deepEqual(result.structuredContent.cities.map(city => city.slug), ['tbilisi']);

    // 4. Ссылка на заявку: двоеточия в позициях не ломают разбор, число принимается, неизвестный код — с предупреждением.
    result = await client.callTool({ name: 'create_request_link', arguments: {
      lang: 'ru', title: 'Перевозка дивана', location: 'Сабуртало', note: 'Завтра после 18:00, 2 этаж без лифта',
      items: [{ name: 'Грузчики', quantity: 2, unit: 'человека' }, { name: 'Диван: угловой', quantity: '1', unit: 'шт' }],
      services: ['movers', 'VAN', 'concrete'] } });
    assert.ok(!result.isError, JSON.stringify(result));
    const { url, preview, services, warnings } = result.structuredContent;
    assert.ok(url.startsWith('https://xtender.test/draft?lang=ru&cats=movers%2Cvan&loc=') && !url.includes('+') && !url.includes(' '));
    assert.deepEqual(services, ['movers', 'van']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"concrete" has no providers/);
    assert.equal(preview, 'Перевозка дивана\n- Грузчики — 2 человека\n- Диван угловой — 1 шт\nЗавтра после 18:00, 2 этаж без лифта\nМесто: Сабуртало');
    assert.ok(result.content[0].text.includes('\n' + url + '\n'), 'ссылка отдельной строкой');
    // Ссылка открывает на сайте ту же заявку.
    const html = await (await fetch(url.replace('https://xtender.test', base))).text();
    assert.ok(html.includes('<h2 class="draft-review-title">Перевозка дивана</h2>') && html.includes('<li><span>Диван угловой</span><b>1 шт</b></li>'));
    assert.ok(html.includes('Исполнители в Тбилиси: Грузчики — 2, Перевозки — 1</p>'));
    const parsed = draftLink.parse(Object.fromEntries(new URL(url).searchParams));
    assert.equal(draftLink.text(parsed, 'ru'), preview);

    // 5. Пустая заявка — ошибка с подсказкой; ни одной услуги с исполнителями — предупреждение.
    result = await client.callTool({ name: 'create_request_link', arguments: { lang: 'en', services: ['movers'] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /at least a title, items or a note/);
    result = await client.callTool({ name: 'create_request_link', arguments: { lang: 'en', title: 'Need a notary', services: ['notary'] } });
    assert.ok(!result.isError);
    assert.ok(!result.structuredContent.url.includes('cats='));
    assert.ok(result.structuredContent.warnings.some(text => /may have no providers/.test(text)));

    // 6. В базе ничего не появилось; GET — 405.
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 0);
    const get = await fetch(base + '/mcp');
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
  console.log('mcp tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
