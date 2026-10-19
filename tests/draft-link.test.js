// Ссылка-черновик от ИИ-ассистента (/draft, config/draftLink.js): ассистент в чате собирает заявку и даёт
// ссылку, по ней открывается обычная форма с текстом в поле. Проверяет то, что ломается незаметно: разбор
// позиций, язык страницы, текст в поле и в карточке мессенджера (с экранированием), живые числа исполнителей,
// закрытость от поиска, переключатель языка без потери черновика, источник заявки и /llms.txt.
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
// Язык по письменности текста, как в настоящем translation.service.
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: s => /[ა-ჰ]/.test(s) ? 'ka' : /[а-яё]/i.test(s) ? 'ru' : 'en' });

const draftLink = require('../src/config/draftLink');
const agentApi = require('../src/config/agentApi');
const { translate, normalizeLang } = require('../src/config/i18n');
const root = path.join(__dirname, '..');

let phones = 0;
async function insertMaster(service, city = 'tbilisi') {
  const phone = '+9955002' + String(10000 + ++phones);
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
  app.set('trust proxy', 1);
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
  app.use('/api', require('../src/routes/api.routes'));
  const rfq = require('../src/controllers/rfq.controller');
  app.get('/llms.txt', require('../src/middleware/asyncHandler')(rfq.llmsTxt));
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(String(error.stack)); });
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}

const textarea = html => (html.match(/<textarea id="freeformInput"[^>]*>([^<]*)<\/textarea>/) || [])[1];
const unescape = s => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

(async () => {
  // 1. Разбор ссылки: позиции «название:количество:единица», двоеточие в названии, пустые части, пределы.
  assert.deepEqual(draftLink.parseItems('Бетон М300:15:м3;Арматура d12:2:т'), [{ name: 'Бетон М300', amount: '15 м3' }, { name: 'Арматура d12', amount: '2 т' }]);
  assert.deepEqual(draftLink.parseItems(' Диван ;;Холодильник:1; :5:шт'), [{ name: 'Диван', amount: '' }, { name: 'Холодильник', amount: '1' }]);
  assert.deepEqual(draftLink.parseItems('Кабель: ВВГ 3x2.5:50:м'), [{ name: 'Кабель: ВВГ 3x2.5', amount: '50 м' }]);
  assert.equal(draftLink.parseItems(Array(40).fill('Мешок').join(';')).length, 30);
  assert.equal(draftLink.parseItems(['Первый', 'Второй'])[0].name, 'Первый', 'повторённый параметр — первый');
  assert.equal(draftLink.parse({}), null);
  assert.equal(draftLink.parse({ cats: 'movers', loc: 'vake' }), null, 'без названия, позиций и примечания показывать нечего');
  const ru = draftLink.parse({ title: '  Переезд   из Ваке ', items: 'Диван:1:шт;Холодильник:1:шт', loc: 'saburtalo', note: 'Завтра после 18:00\r\n\r\n 3 этаж, без лифта ', cats: 'Movers, van,../x,van' });
  assert.deepEqual(ru, { title: 'Переезд из Ваке', items: [{ name: 'Диван', amount: '1 шт' }, { name: 'Холодильник', amount: '1 шт' }],
    note: 'Завтра после 18:00\n3 этаж, без лифта', loc: 'saburtalo', cats: ['movers', 'van'], lang: 'ru' });
  assert.equal(draftLink.text(ru, 'ru'), 'Переезд из Ваке\n- Диван — 1 шт\n- Холодильник — 1 шт\nЗавтра после 18:00\n3 этаж, без лифта\nМесто: Saburtalo');
  assert.equal(draftLink.parse({ title: 'Move a sofa', lang: 'KA' }).lang, 'ka', 'lang из ссылки важнее письменности');
  assert.equal(draftLink.parse({ title: 'ავეჯის გადატანა' }).lang, 'ka');
  assert.equal(draftLink.parse({ title: 'Move a sofa', lang: 'de' }).lang, 'en');
  assert.equal(draftLink.place('old-tbilisi'), 'Old Tbilisi');
  assert.equal(draftLink.place('Сабуртало'), 'Сабуртало');
  // Разметка жирного шрифта, которую модель перенесла в ссылку («1 шт**», Gemini), убирается.
  assert.deepEqual(draftLink.parseItems('**Диван**:1:шт**'), [{ name: 'Диван', amount: '1 шт' }]);
  assert.equal(draftLink.parse({ title: '**Переезд**' }).title, 'Переезд');
  assert.deepEqual(draftLink.card(ru, 'ru'), { title: 'Заявка: Переезд из Ваке', description: 'Диван — 1 шт; Холодильник — 1 шт · Saburtalo' });

  // Каталог: три грузчика и перевозка в Тбилиси, грузчик в Батуми (город включён).
  await pool.query("UPDATE cities SET is_active=true WHERE slug='batumi'");
  for (let i = 0; i < 3; i++) await insertMaster('movers');
  await insertMaster('van');
  await insertMaster('movers', 'batumi');

  const server = await startSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  try {
    // 2. Страница по ссылке: русский по адресу, текст в поле, пояснение с живыми числами, закрыта от поиска,
    //    карточка мессенджера по задаче, canonical — полный адрес, грузчики первыми.
    const query = 'title=' + encodeURIComponent('Переезд из Ваке') + '&items=' + encodeURIComponent('Диван:1:шт;Холодильник:1:шт')
      + '&loc=saburtalo&note=' + encodeURIComponent('3 этаж, без лифта') + '&cats=movers,van,tow,unknown';
    let response = await get('/ru/draft?' + query + '&lang=en');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    let html = await response.text();
    const t = translate('ru');
    assert.match(html, /<html lang="ru"/, 'язык адреса важнее параметра lang');
    assert.equal(unescape(textarea(html)), 'Переезд из Ваке\n- Диван — 1 шт\n- Холодильник — 1 шт\n3 этаж, без лифта\nМесто: Saburtalo');
    assert.ok(html.includes(t('draft_note_title')) && html.includes(t('draft_note_body')));
    // Готовая заявка: заголовок, позиции, место и две кнопки; поле с тем же текстом спрятано до «Изменить».
    assert.ok(html.includes('<h2 class="draft-review-title">Переезд из Ваке</h2>'));
    assert.ok(html.includes('<li><span>Диван</span><b>1 шт</b></li>') && html.includes('<li><span>Холодильник</span><b>1 шт</b></li>'));
    assert.ok(html.includes('<p class="draft-review-note">3 этаж, без лифта</p>') && html.includes('Место: <b>Saburtalo</b>'));
    assert.ok(html.includes('onclick="submitFreeform()"') && html.includes(t('draft_confirm')) && html.includes('onclick="editDraft()"') && html.includes(t('draft_edit')));
    assert.match(html, /class="composer-inputbox mt-2.5 hidden flex-col/, 'поле спрятано');
    assert.ok(html.includes('Исполнители в Тбилиси: Грузчики — 3, Перевозки — 1</p>'), 'числа — из каталога; эвакуаторов нет, неизвестный код отброшен');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(html.includes('<meta property="og:title" content="Заявка: Переезд из Ваке">'));
    assert.ok(html.includes('<meta property="og:description" content="Диван — 1 шт; Холодильник — 1 шт · Saburtalo">'));
    assert.ok(html.includes(`<link rel="canonical" href="https://xtender.test/ru/draft?${query.replace(/&/g, '&amp;')}&amp;lang=en">`));
    assert.doesNotMatch(html, /hreflang="(ka|ru|en)"/, 'страница закрыта от поиска — без языковых версий');
    const services = [...html.matchAll(/class="master-card [^"]*"[^>]*data-services="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(services.slice(0, 4).map(list => /movers|van/.test(list)), [true, true, true, true], 'услуги из ссылки первыми');
    assert.ok(html.includes('draft: true || undefined'), 'форма помечает заявку как пришедшую по ссылке');
    // Переключатель языка уносит черновик, lang не переносит: язык решает адрес.
    const carried = new URLSearchParams(query).toString().replace(/&/g, '&amp;');
    assert.ok(html.includes(`href="https://xtender.test/draft?lang=ka&amp;${carried}"`), 'на грузинский — с ?lang=ka');
    assert.ok(html.includes(`href="https://xtender.test/en/draft?${carried}"`), 'на английский');

    // 3. Без языка в адресе: lang из ссылки, иначе по тексту. Место — город из базы: каталог этого города.
    html = await (await get('/draft?lang=ka&title=' + encodeURIComponent('ავეჯის გადატანა') + '&loc=batumi&cats=movers')).text();
    assert.match(html, /<html lang="ka"/);
    assert.equal(unescape(textarea(html)), 'ავეჯის გადატანა\nადგილი: Batumi');
    assert.ok(html.includes('შემსრულებლები ბათუმში: მუშები — 1</p>'), 'каталог Батуми');
    html = await (await get('/draft?title=' + encodeURIComponent('Вывезти мусор'))).text();
    assert.match(html, /<html lang="ru"/);
    assert.doesNotMatch(html, /draft-review-services/, 'без кодов услуг — без строки с числами');

    // 4. Пустая ссылка ведёт на главную; разметка из ссылки экранируется в поле и в карточке.
    response = await get('/en/draft?cats=movers');
    assert.deepEqual([response.status, response.headers.get('location')], [302, '/en']);
    response = await get('/draft');
    assert.deepEqual([response.status, response.headers.get('location')], [302, '/']);
    html = await (await get('/en/draft?title=' + encodeURIComponent('<script>alert(1)</script>"><img src=x>'))).text();
    assert.doesNotMatch(html, /<script>alert\(1\)|<img src=x>/);
    assert.equal(unescape(textarea(html)), '<script>alert(1)</script>"><img src=x>');

    // 5. Заявка с формы, открытой по ссылке, получает свой источник; без отметки — как раньше.
    const consent = await require('../src/services/consent.service').bundle('client', 'ru');
    const send = async (extra) => {
      const body = { phone: '+99555500' + String(1000 + ++phones), description: 'Переезд из Ваке', termsAccepted: true, privacyAccepted: true,
        consentLanguage: consent.language, consentDigest: consent.digest, entry: { us: '', r: 'https://chatgpt.com' }, ...extra };
      const data = await (await fetch(base + '/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      assert.equal(data.success, true, JSON.stringify(data));
      return (await pool.query('SELECT source FROM orders WHERE token=$1', [data.token])).rows[0].source;
    };
    assert.equal(await send({ draft: true }), agentApi.DRAFT_SOURCE);
    assert.equal(await send({ draft: 'yes' }), 'chatgpt.com');
    assert.equal(await send({}), 'chatgpt.com');

    // 6. Подсказка ИИ-агентам на страницах: тег в <head> и заголовки ответа ведут на /llms.txt; на странице нет
    //    обещаний услуг, которых нет в каталоге.
    response = await get('/ru');
    assert.deepEqual([response.headers.get('link'), response.headers.get('x-agentic-protocol')],
      ['<https://xtender.test/llms.txt>; rel="help"; type="text/plain"', agentApi.AGENT_PROTOCOL]);
    html = await response.text();
    assert.ok(html.includes('<link rel="help" type="text/plain" href="https://xtender.test/llms.txt">'));
    const hint = (html.match(/<meta name="ai-agent-instructions" content="([^"]*)">/) || [])[1];
    assert.ok(hint && hint.includes('https://xtender.test/llms.txt') && hint.includes('https://xtender.test/draft'), 'тег с адресами');
    assert.doesNotMatch(hint, /concrete|rebar|Batumi/i);
    // Видимая ссылка внизу страницы, с адресом текстом.
    assert.ok(html.includes('<a href="/llms.txt" class="text-stone-500 hover:text-white transition">Для ИИ-ассистентов: xtender.ge/llms.txt</a>'));

    // 7. /llms.txt: формат ссылки, пример с настоящим кодом, коды услуг с числами по городам, API — вторым путём.
    require('../src/controllers/rfq.controller')._resetCatalog();
    const llms = await (await get('/llms.txt')).text();
    // Первым после описания — правило для ассистента: готовая ссылка, а не «заполните форму на сайте».
    assert.match(llms, /^# xtender\.ge\n\n> .+\n\n## For AI assistants: give the user a ready link\n\nWhen a user wants to hire a local service in Georgia, do not tell them to go to the website and fill in the form by hand\./);
    assert.ok(llms.indexOf('## For AI assistants') < llms.indexOf('## Link format') && llms.indexOf('## Link format') < llms.indexOf('## Create a request through the API'));
    assert.ok(llms.includes('`https://xtender.test/draft?lang=…&cats=…&loc=…&title=…&items=…&note=…`'));
    assert.doesNotMatch(llms, /instantly|concrete|rebar/i, 'без обещаний, которых сайт не держит');
    const example = llms.match(/^Example: (\S+)$/m)[1];
    assert.ok(example.startsWith('https://xtender.test/draft?lang=en&cats=movers&loc=Saburtalo&title=Move%20a%20sofa'));
    assert.match(llms, /^- `movers` Movers: \[Tbilisi\]\(https:\/\/xtender\.test\/en\/s\/mushebi-tbilisi\) 3, Batumi 1$/m, 'у открытой поиску страницы — ссылка');
    assert.match(llms, /^- `van` Transport: Tbilisi 1$/m);
    assert.doesNotMatch(llms, /`tow`/, 'услуги без исполнителей не перечислены');
    // Пример из llms.txt открывается и даёт заполненную форму.
    html = await (await get(example.replace('https://xtender.test', ''))).text();
    assert.equal(unescape(textarea(html)), 'Move a sofa and a fridge\n- Sofa — 1 pc\n- Fridge — 1 pc\nTomorrow after 18:00, 3rd floor, no lift\nLocation: Saburtalo');
  } finally {
    server.close();
  }
  console.log('draft-link tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
