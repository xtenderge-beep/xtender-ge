// Кнопка «Решить с ChatGPT» (config/chatgptPrompt.js, ТЗ владельца 2026-10-21): сайт собирает запрос и открывает
// chatgpt.com/?q=<запрос>. Проверяет то, что ломается незаметно: сценарий страницы находится сам, инструкция в запросе
// совпадает с /llms.txt (те же коды услуг, тот же формат ссылки, пример из запроса открывает заполненную заявку),
// в запросе нет личных данных, адрес ChatGPT раскодируется ровно в запрос, длинный запрос уходит коротким вариантом,
// тестовая страница закрыта от поиска, на настоящих страницах кнопка только по ?gpt=1.
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
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool);
stub('../src/config/redis', redis);
stub('../src/services/sms.service', { sendOtp: async () => ({}), sendOrderNotification: async () => ({ ok: true, providerMessageId: 'test' }) });
stub('../src/services/telegram.service', new Proxy({}, { get: () => async () => null }));
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: s => /[ა-ჰ]/.test(s) ? 'ka' : /[а-яё]/i.test(s) ? 'ru' : 'en' });

const chatgptPrompt = require('../src/config/chatgptPrompt');
const agentApi = require('../src/config/agentApi');
const googleTag = require('../src/config/googleTag');
const { translate, normalizeLang } = require('../src/config/i18n');
const root = path.join(__dirname, '..');
const BASE = 'https://xtender.test';

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
  return master;
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
  const publicRoutes = require('../src/routes/public.routes');
  app.use('/', publicRoutes);
  app.use('/:locale(ru|en)', publicRoutes);
  const rfq = require('../src/controllers/rfq.controller');
  app.get('/llms.txt', require('../src/middleware/asyncHandler')(rfq.llmsTxt));
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(String(error.stack)); });
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}

const unescape = s => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const components = html => [...html.matchAll(/<div class="ai-solve" data-ai-solve data-scenario="([^"]*)" data-variant="([^"]*)" data-prompt="([^"]*)"[^>]*>\s*<a class="ai-solve-open" href="([^"]*)"/g)]
  .map(([, scenario, variant, prompt, href]) => ({ scenario, variant, prompt: unescape(prompt), href: unescape(href) }));

(async () => {
  // 1. Сценарий страницы: свой — по адресу, у главной — home, у остальных страниц — тема из заголовка.
  assert.equal(chatgptPrompt.scenarioFor('ru', { slug: 'mushebi-tbilisi', title: 'Грузчики в Тбилиси' }).id, 'movers');
  assert.equal(chatgptPrompt.scenarioFor('ka', { slug: 'samsheneblo-nagvis-gatana', title: 'x' }).topic, 'სამშენებლო ნარჩენების გატანა');
  assert.deepEqual(chatgptPrompt.scenarioFor('ru', { slug: 'avejis-gadazidva', title: 'Перевозка мебели' }),
    { id: 'page:avejis-gadazidva', title: 'Перевозка мебели', topic: 'Перевозка мебели', goal: 'организовать работы и найти подходящих исполнителей' });
  assert.equal(chatgptPrompt.scenarioFor('en', {}).id, 'home');
  assert.equal(chatgptPrompt.scenarioFor('de', { id: 'apartment_renovation' }).title, 'ბინის რემონტი', 'неизвестный язык — грузинский');
  assert.deepEqual(chatgptPrompt.TEST_SCENARIOS, ['apartment_renovation', 'construction_waste', 'movers'], 'первый этап — три сценария ТЗ');

  // Каталог: три грузчика и вывоз мусора в Тбилиси.
  for (let i = 0; i < 3; i++) await insertMaster('movers');
  await insertMaster('junk');

  const server = await startSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  try {
    // 2. Тестовая страница: закрыта от поиска, три кнопки, адрес ChatGPT раскодируется ровно в запрос.
    let response = await get('/ru/chatgpt');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    let html = await response.text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<script src="\/js\/ai-solve\.js" defer><\/script>/);
    const found = components(html);
    assert.deepEqual(found.map(item => item.scenario), ['apartment_renovation', 'construction_waste', 'movers']);
    for (const item of found) {
      assert.equal(item.variant, 'full');
      const url = new URL(item.href);
      assert.equal(url.origin + url.pathname, 'https://chatgpt.com/');
      assert.equal(url.searchParams.get('q'), item.prompt, 'в ChatGPT уходит тот же текст, что копируется');
    }
    assert.ok(html.includes('Решить с ChatGPT') && html.includes('ChatGPT поможет разобраться в задаче, подобрать необходимые услуги и подготовить заявку исполнителям'));
    assert.ok(html.includes('href="/ru/s/mushebi-tbilisi?gpt=1"') && html.includes('href="/ru/s/samsheneblo-nagvis-gatana?gpt=1"'), 'ссылки на настоящие страницы');

    // 3. Запрос: контекст страницы, правила, инструкция из того же источника, что /llms.txt.
    const movers = found[2].prompt;
    assert.ok(movers.startsWith('Помоги мне решить задачу через сервис xtender.ge.\n\nКонтекст:\n- Тема: поиск грузчиков.\n- Место: Тбилиси, Грузия.\n- Источник: https://xtender.test/ru/s/mushebi-tbilisi\n'));
    assert.ok(movers.includes('Не отправляй заявку за меня.'), 'заявку подтверждает человек');
    assert.ok(movers.includes(agentApi.promptGuide(BASE, await require('../src/services/assistantCatalog.service').get(), 'ru')));
    assert.ok(movers.includes('- Request link: https://xtender.test/draft?lang=ru&cats=CODES&text=TEXT'));
    assert.ok(movers.includes('  - movers (Movers / Грузчики): Tbilisi 3') && movers.includes('  - junk (Waste removal / Вывоз мусора): Tbilisi 1'));
    assert.doesNotMatch(movers, /- (van|tow) \(/, 'услуги без исполнителей не перечислены');
    assert.ok(found[0].prompt.includes('По остальным этапам скажи прямо, что на xtender.ge исполнителей пока нет.'), 'ремонт — честно, с тем что есть');
    assert.ok(found[0].prompt.includes('- Источник: https://xtender.test/ru\n'), 'у ремонта своей страницы нет');
    // Личных данных нет; команд «проверь память» тоже (защита ассистента сочла бы их атакой, docs/ai-agent-api.md).
    for (const item of found) {
      assert.doesNotMatch(item.prompt, /\+995|5003\d{5}|token-/, 'ни телефонов, ни ссылок с секретами');
      assert.doesNotMatch(item.prompt, /памят|истори|memory|history/i);
    }
    // Те же коды, что в /llms.txt.
    const llms = await (await get('/llms.txt')).text();
    const llmsCodes = [...llms.matchAll(/^- `([a-z0-9_]+)` /gm)].map(match => match[1]).sort();
    const promptCodes = [...movers.matchAll(/^ {2}- ([a-z0-9_]+) \(/gm)].map(match => match[1]).sort();
    assert.deepEqual(promptCodes, llmsCodes);
    // Пример из запроса открывает заполненную заявку.
    const example = movers.match(/^- Example: (\S+)$/m)[1];
    html = await (await get(example.replace(BASE, ''))).text();
    assert.ok(html.includes('<p class="draft-review-body">2 movers and construction waste removal, about 2 m3 in bags.'));

    // 4. Грузинская страница: тексты по-грузински, инструкция по-английски с грузинскими названиями услуг.
    html = await (await get('/chatgpt?lang=ka')).text();
    const ka = components(html);
    assert.ok(html.includes('გადაწყვიტეთ ChatGPT-ით'));
    assert.ok(ka[2].prompt.includes('- თემა: მუშების პოვნა.') && ka[2].prompt.includes('- ადგილი: თბილისი, საქართველო.'));
    assert.ok(ka[2].prompt.includes('lang=ka&cats=CODES') && ka[2].prompt.includes('movers (Movers / მუშები)'));
    assert.ok(ka.every(item => item.href.length <= chatgptPrompt.MAX_URL), 'грузинский запрос помещается в адрес');

    // 5. Длинный запрос (много услуг) уходит коротким вариантом; скопировать можно полный.
    const many = [{ name: 'Tbilisi', services: Array.from({ length: 80 }, (_, i) => ({ code: 'svc_' + i, label: 'Service ' + i, names: { ka: 'მომსახურება ' + i }, count: 1 })) }];
    const long = chatgptPrompt.build({ base: BASE, lang: 'ka', catalog: many, city: null, scenario: chatgptPrompt.scenarioFor('ka', { id: 'movers' }), source: BASE });
    assert.equal(long.variant, 'short');
    assert.equal(long.href, long.shortUrl);
    assert.ok(long.fullUrl.length > chatgptPrompt.MAX_URL && long.shortUrl.length < chatgptPrompt.MAX_URL);
    assert.ok(long.short.includes('svc_79') && long.full.includes('svc_79'));

    // 6. Настоящие страницы: кнопка только по ?gpt=1, сценарий — по адресу или заголовку; на /draft её нет.
    html = await (await get('/ru/s/mushebi-tbilisi')).text();
    assert.equal(components(html).length, 0);
    assert.doesNotMatch(html, /ai-solve\.js/);
    html = await (await get('/ru/s/mushebi-tbilisi?gpt=1')).text();
    assert.deepEqual(components(html).map(item => item.scenario), ['movers']);
    assert.match(html, /<script src="\/js\/ai-solve\.js" defer><\/script>/);
    html = await (await get('/ru/s/samsheneblo-nagvis-gatana?gpt=1')).text();
    assert.deepEqual(components(html).map(item => item.scenario), ['construction_waste']);
    html = await (await get('/ru/s/avejis-gadazidva?gpt=1')).text();
    assert.deepEqual(components(html).map(item => item.scenario), ['page:avejis-gadazidva'], 'страница без сценария — по заголовку');
    html = await (await get('/en?gpt=1')).text();
    assert.deepEqual(components(html).map(item => item.scenario), ['home']);
    html = await (await get('/ru/draft?cats=movers&text=' + encodeURIComponent('2 грузчика') + '&gpt=1')).text();
    assert.equal(components(html).length, 0, 'на заявке из ссылки кнопки нет');

    // 7. События кнопки уходят в Google Analytics и с тестовой страницы.
    assert.equal(googleTag.idFor('/chatgpt', 'G-TEST1'), 'G-TEST1');
    assert.equal(googleTag.idFor('/ru/chatgpt', 'G-TEST1'), 'G-TEST1');
  } finally {
    server.close();
  }
  console.log('chatgpt-prompt tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
