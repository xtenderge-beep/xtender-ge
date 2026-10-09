// Страницы под рекламу и поиск (/s/<slug>): services/landingPage.service.js, маршруты в
// routes/public.routes.js, блоки в views/index.ejs, раздел /admin/landings, карта сайта.
// Проверяет то, что ломается незаметно: начальные страницы возвращаются после удаления, число на
// экране расходится с настоящей рассылкой, в текстах появляется обещание цены или скорости, реклама
// теряет метку клика при переадресации, поисковик получает языки, которых у страницы нет, меняется
// общая главная или телефонная раскладка, от которой зависит прежняя полноэкранная форма.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ejs = require('ejs');
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
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru' });

const servicePath = require.resolve('../src/services/landingPage.service');
let landingPages = require(servicePath);
const orders = require('../src/services/order.service');
const settings = require('../src/services/settings.service');
const { sitemapXml } = require('../src/config/seo');
const { translate, normalizeLang } = require('../src/config/i18n');
const googleTag = require('../src/config/googleTag');

const LANGS = ['ka', 'ru', 'en'];
const root = path.join(__dirname, '..');
const ATTRIBUTES = { movers: {}, van: { size: 'L', body: 'closed' }, junk: { volume_m3: '4' } };
const rejects = (promise, pattern) => assert.rejects(promise, error => error.status === 400 && pattern.test(error.message));

let phones = 0;
async function insertMaster(name, services, { balance = 1000, banned = false, city = 'tbilisi' } = {}) {
  const phone = '+9955000' + String(10000 + ++phones);
  const master = (await pool.query(
    `INSERT INTO masters(name,phone,category,is_active,is_subscribed,balance_tetri,master_token,city_id)
     VALUES($1,$2,$3,true,true,$4,$5,(SELECT id FROM cities WHERE slug=$6)) RETURNING *`,
    [name, phone, services[0] === 'van' ? 'transport' : services[0], balance, 'token-' + phone, city])).rows[0];
  for (const [index, service] of services.entries())
    await pool.query('INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,$2,$3::jsonb,$4)', [master.id, service, JSON.stringify(ATTRIBUTES[service]), index === 0]);
  await require('./billing-fixture')(pool, master.id);
  // Заблокированный профиль тарифы принять не может, поэтому блокировка ставится после.
  if (banned) await pool.query('UPDATE masters SET is_banned=true WHERE id=$1', [master.id]);
  return master;
}

// Тот же порядок подключения, что в src/app.js, без остальных маршрутов.
function startSite() {
  const express = require('express');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(require('cookie-parser')());
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'src/views'));
  app.use((req, res, next) => {
    req.lang = normalizeLang(req.cookies.lang);
    Object.assign(res.locals, { lang: req.lang, currentPath: req.originalUrl, t: translate(req.lang), isRememberedProvider: false, googleTagId: googleTag.idFor(req.path, 'G-TEST123456') });
    next();
  });
  const publicRoutes = require('../src/routes/public.routes');
  app.use('/', publicRoutes);
  app.use('/:locale(ru|en)', publicRoutes);
  app.use((error, req, res, next) => { console.error(error); res.status(500).send(String(error.stack)); });
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}

(async () => {
  // 1. Начальные страницы пишутся один раз; удаление и правки администратора остаются в силе.
  let pages = await landingPages.list();
  assert.deepEqual(pages.map(page => page.slug), ['avejis-gadazidva', 'tvirtis-gadazidva', 'samsheneblo-nagvis-gatana']);
  assert.deepEqual(pages.map(page => page.categories), [['movers', 'transport'], ['transport'], ['junk']]);
  assert.equal((await landingPages.list()).length, 3, 'a second read adds nothing');
  for (const page of pages) {
    assert.deepEqual(landingPages.languages(page), LANGS, page.slug + ': all three languages are filled');
    assert.equal(page.is_active, true);
    // Грузинские статьи ждут вычитки носителем и до неё не показываются.
    assert.deepEqual(LANGS.map(lang => page.content[lang].article_on), [false, true, true], page.slug + ': the Georgian article is off until proofread');
    for (const lang of LANGS) assert.ok(page.content[lang].article.length > 600, `${page.slug}/${lang}: the article is written`);
  }
  // Заголовки ka повторяют поисковые запросы слово в слово, адрес — запрос латиницей.
  assert.deepEqual(pages.map(page => page.content.ka.title), ['ავეჯის გადაზიდვა', 'ტვირთის გადაზიდვა', 'სამშენებლო ნაგვის გატანა']);

  const cargoId = pages[1].id;
  await landingPages.remove(cargoId);
  const junkPage = pages[2];
  await landingPages.save(junkPage.id, { ...junkPage, is_active: true, content: { ...junkPage.content, ka: { ...junkPage.content.ka, title: 'ნაგვის გატანა' } } });
  // Новый процесс (перезапуск сервера): модуль загружается заново и не должен ничего возвращать.
  delete require.cache[servicePath];
  landingPages = require(servicePath);
  pages = await landingPages.list();
  assert.deepEqual(pages.map(page => page.slug), ['avejis-gadazidva', 'samsheneblo-nagvis-gatana'], 'a deleted page does not come back after a restart');
  assert.equal(pages[1].content.ka.title, 'ნაგვის გატანა', 'an edited page keeps the edit after a restart');
  // Возвращаем три страницы для остальных проверок.
  const seed = require('../src/config/landing-seed');
  await landingPages.save(null, { ...seed[1], is_active: true });
  await landingPages.save(pages[1].id, { ...seed[2], is_active: true });
  pages = await landingPages.list();
  assert.deepEqual(pages.map(page => page.slug), ['avejis-gadazidva', 'tvirtis-gadazidva', 'samsheneblo-nagvis-gatana']);
  const [moving, cargo, junk] = pages;

  // 2. Тексты первого экрана не обещают цену и скорость; статьи — скорость.
  const speed = { ru: /минут|сразу|быстр|гарант|мгновен/i, en: /minute|instant|fast|guarant|immediate/i, ka: /წუთ|სწრაფად|გარანტ|მაშინვე/ };
  // ka: «უფასოა» (бесплатно) содержит корень «ფას» (цена), поэтому он исключён.
  const price = { ru: /цен/i, en: /price|quote/i, ka: /(?<!უ)ფას/ };
  for (const page of pages) for (const lang of LANGS) {
    const text = page.content[lang];
    for (const field of ['title', 'accent', 'post', 'post_one', 'post_plain', 'choose', 'fact1', 'fact2', 'placeholder', 'seo_title', 'seo_description']) {
      assert.doesNotMatch(text[field] || '', speed[lang], `${page.slug}/${lang}/${field} promises a speed`);
      assert.doesNotMatch(text[field] || '', price[lang], `${page.slug}/${lang}/${field} promises a price`);
    }
    assert.doesNotMatch(text.article, speed[lang], `${page.slug}/${lang}: the article promises a speed`);
    assert.ok(text.seo_title.length <= 80 && text.seo_description.length <= 200, `${page.slug}/${lang}: search title and description fit`);
  }

  // 3. «Группа» — это те, кому рассылка такой заявки ушла бы сейчас.
  const tbilisi = (await pool.query("SELECT id FROM cities WHERE slug='tbilisi'")).rows[0].id;
  for (let i = 1; i < landingPages.MIN_GROUP; i++) await insertMaster('Mover ' + i, ['movers']);
  let view = await landingPages.view(moving, 'ru', tbilisi);
  assert.equal(view.count, 0, 'a group below the minimum is not given a number');
  assert.deepEqual(view.post, ['Разместите пост в группе ', 'грузчиков и водителей', '']);
  assert.equal(view.initials.length, 4, 'the circles still show who is there');
  view = await landingPages.view(junk, 'ru', tbilisi);
  assert.deepEqual([view.count, view.initials], [0, []], 'nobody for the task: no number, no circles');

  await insertMaster('Zaza', ['movers']);
  await insertMaster('გიორგი', ['movers']);
  await insertMaster('No money', ['movers'], { balance: 0 });
  await insertMaster('Banned', ['movers'], { banned: true });
  await insertMaster('Batumi', ['movers'], { city: 'batumi' });
  for (let i = 1; i <= 5; i++) await insertMaster('Van ' + i, ['van']);
  await insertMaster('Both', ['movers', 'van']);
  for (let i = 1; i <= 5; i++) await insertMaster('Junk ' + i, ['junk']);
  const leadPrice = await settings.getLeadPriceTetri();
  const recipients = async category => (await orders.getDispatchRecipients(category, '', leadPrice, false, '', { id: 0, city_id: tbilisi, target_categories: [], requirements: {} })).map(m => m.id);
  const [movers, vans, junkers] = [await recipients('movers'), await recipients('transport'), await recipients('junk')];
  assert.deepEqual([movers.length, vans.length, junkers.length], [7, 6, 5], 'no balance, banned and another city are not counted');

  view = await landingPages.view(moving, 'ru', tbilisi);
  assert.equal(view.count, new Set([...movers, ...vans]).size, 'moving: the number equals the recipients of a real dispatch');
  assert.equal(view.count, 12, 'a provider with both services is counted once');
  assert.deepEqual(view.post, ['Разместите пост в группе из ', '12 грузчиков и водителей', '']);
  assert.deepEqual(view.initials, ['M', 'M', 'M', 'M'], 'first letters of the names shown to customers');
  assert.deepEqual(view.facts, ['Бесплатно', 'Заинтересованные сами свяжутся с вами']);
  assert.ok(view.article.some(block => block.h === 'Как это работает') && view.article.some(block => Array.isArray(block.ul)), 'ru: the article is parsed into headings and lists');
  assert.equal((await landingPages.view(cargo, 'ka', tbilisi)).count, vans.length, 'cargo counts vehicles only');
  assert.equal((await landingPages.view(junk, 'en', tbilisi)).count, junkers.length, 'junk counts waste removal only');
  assert.deepEqual((await landingPages.view(moving, 'ka', tbilisi)).article, [], 'ka: the article is off');
  assert.deepEqual((await landingPages.view(moving, 'ka', tbilisi)).post, ['დადეთ პოსტი ', '12 მუშისა და მძღოლის', ' ჯგუფში']);
  assert.equal(landingPages.countForm(21, 'ru'), 'one');
  assert.equal(landingPages.countForm(11, 'ru'), 'many');
  // Число на 1 по-русски берёт свою фразу: «из 21 водителя».
  const realRecipients = orders.getDispatchRecipients;
  orders.getDispatchRecipients = async () => Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: 'N' + i }));
  assert.deepEqual((await landingPages.view(cargo, 'ru', tbilisi)).post, ['Разместите пост в группе из ', '21 водителя', '']);
  // Сбой подсчёта не роняет страницу: экран показывает фразу без числа.
  const log = console.error;
  orders.getDispatchRecipients = async () => { throw new Error('db down'); };
  console.error = () => {};
  assert.deepEqual(await landingPages.audience(['movers'], tbilisi), { count: 0, initials: [] });
  orders.getDispatchRecipients = realRecipients; console.error = log;

  // 4. Проверка полей при сохранении из админки.
  const draft = (change = {}) => ({ slug: 'test-page', admin_name: 'Тест', categories: ['movers'], is_active: 'on', sort_order: '50',
    content: { ru: { title: 'Грузчики', post: 'В группе [{count} грузчиков]', post_plain: 'В группе [грузчиков]', choose: 'и выберите.', placeholder: 'Например: шкаф.' } }, ...change });
  const ruText = change => draft({ content: { ru: { ...draft().content.ru, ...change } } });
  await rejects(landingPages.save(null, draft({ slug: 'Плохой адрес' })), /Адрес/);
  await rejects(landingPages.save(null, draft({ slug: 'two--dashes' })), /Адрес/);
  await rejects(landingPages.save(null, draft({ admin_name: ' ' })), /название/);
  await rejects(landingPages.save(null, draft({ categories: ['movers', 'nobody'] })), /неизвестная группа/);
  await rejects(landingPages.save(null, draft({ content: {} })), /хотя бы на одном языке/);
  await rejects(landingPages.save(null, ruText({ choose: '' })), /На русском заполните: «Вторая строка фразы»/);
  await rejects(landingPages.save(null, ruText({ post: 'В группе грузчиков' })), /нет \{count\}/);
  await rejects(landingPages.save(null, ruText({ post_plain: 'В группе [{count} грузчиков]' })), /не нужен/);
  await rejects(landingPages.save(null, ruText({ post: 'В [группе] [{count} грузчиков]' })), /один раз/);
  await rejects(landingPages.save(null, ruText({ post: 'В группе ]{count}[' })), /один раз/);
  await rejects(landingPages.save(null, ruText({ title: 'я'.repeat(121) })), /длиннее 120/);
  await rejects(landingPages.save(null, draft({ slug: 'avejis-gadazidva' })), /уже есть/);
  const created = await landingPages.save(null, draft());
  assert.deepEqual([created.slug, created.is_active, created.sort_order, created.categories], ['test-page', true, 50, ['movers']]);
  assert.deepEqual(landingPages.languages(created), ['ru'], 'only the filled language exists');
  const noBrackets = await landingPages.save(created.id, ruText({ post: 'В группе {count} грузчиков', post_plain: 'В группе грузчиков' }));
  assert.deepEqual((await landingPages.view(noBrackets, 'ru', tbilisi)).post, ['В группе 7 грузчиков'], 'brackets are optional: the phrase is shown without a highlight');
  assert.match((await landingPages.view(noBrackets, 'ru', tbilisi)).seoTitle, /^Грузчики \| xtender\.ge$/, 'an empty search title falls back to the headline');
  await rejects(landingPages.save(999999, draft({ slug: 'ghost' })), /не найдена/);

  // 5. Адреса: страница, языки, переадресации и метка клика рекламы.
  const server = await startSite();
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  try {
    for (const page of [moving, cargo, junk]) for (const lang of LANGS) {
      const url = (lang === 'ka' ? '' : '/' + lang) + '/s/' + page.slug, where = `${lang}${url}`;
      const response = await get(url + (lang === 'ka' ? '?lang=ka' : ''));
      assert.equal(response.status, 200, where);
      const html = await response.text(), text = page.content[lang];
      const head = html.slice(0, html.indexOf('</head>'));
      const self = 'https://xtender.test' + url;
      assert.ok(head.includes(`<title>${text.seo_title}</title>`), `${where}: its own tab title`);
      assert.ok(head.includes(`<meta name="description" content="${text.seo_description}">`), `${where}: its own description`);
      assert.ok(head.includes(`<link rel="canonical" href="${self}">`), `${where}: the page is its own canonical address`);
      for (const other of LANGS) assert.ok(head.includes(`<link rel="alternate" hreflang="${other}" href="https://xtender.test${other === 'ka' ? '' : '/' + other}/s/${page.slug}">`), `${where}: hreflang ${other}`);
      assert.ok(head.includes(`<link rel="alternate" hreflang="x-default" href="https://xtender.test/s/${page.slug}">`), `${where}: x-default`);
      assert.ok(head.includes(`<meta property="og:title" content="${text.seo_title}">`) && head.includes(`<meta property="og:url" content="${self}">`), `${where}: sharing tags`);
      const structured = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
      const service = structured.find(item => item['@type'] === 'Service'), crumbs = structured.find(item => item['@type'] === 'BreadcrumbList');
      assert.deepEqual([service.name, service.url, service.serviceType], [`${text.title} ${text.accent}`, self, text.title], `${where}: Service data`);
      assert.deepEqual(crumbs.itemListElement.map(item => item.item), ['https://xtender.test' + (lang === 'ka' ? '/' : '/' + lang), self], `${where}: breadcrumbs`);
      assert.match(head, /googletagmanager|google-tag\.js|G-TEST123456/, `${where}: the Google tag is on the page ads lead to`);

      assert.match(html, /<body class="home-page home-topic /, `${where}: marked as a task page`);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${where}: exactly one h1`);
      assert.ok(html.includes(`<h1 class="home-hero-title">${text.title} <span>${text.accent}</span></h1>`), `${where}: the headline`);
      const count = (await landingPages.view(page, lang, tbilisi)).count;
      const [before, bold, after] = text.post.replace('{count}', count).split(/[\[\]]/);
      assert.ok(html.includes(`<span class="home-usp-post">${before}<b>${bold}</b>${after}</span> <span class="home-usp-choose">${text.choose}</span>`), `${where}: the sentence with the real number`);
      assert.ok(html.includes(`</i>${text.fact1}</li>`) && html.includes(`</i>${text.fact2}</li>`), `${where}: two facts under the form`);
      assert.ok(html.includes(`placeholder="${text.placeholder}"`), `${where}: the example fits the task`);
      assert.doesNotMatch(html, /class="home-hero-lead"|class="home-catalog-strip"/, `${where}: the general lead and counter are replaced`);
      assert.equal(html.includes('<article class="home-article">'), lang !== 'ka', `${where}: article shown only where it is switched on`);
      if (lang !== 'ka') assert.ok(html.includes(`<h2>${text.article.match(/^## (.+)$/m)[1]}</h2>`), `${where}: article headings are h2`);
      // Ссылки на остальные страницы задач и переключатель языка.
      for (const other of [moving, cargo, junk]) assert.equal(html.includes(`<a href="${lang === 'ka' ? '' : '/' + lang}/s/${other.slug}">`), other.id !== page.id, `${where}: link to ${other.slug}`);
      assert.equal((html.match(new RegExp(`<a href="https://xtender\\.test[^"]*/s/${page.slug}[^"]*" aria-label="(?:GE|RU|EN)"`, 'g')) || []).length, 3, `${where}: language switch stays on the page`);
      // The request form is the same one: same field, same handlers, same steps.
      for (const piece of ['id="freeformInput"', 'onclick="submitFreeform()"', 'onclick="exitCompose()"', 'id="phoneStep"', 'id="otpStep"', 'class="composer-toprow"', 'for="freeformInput"', 'id="hxToggle"'])
        assert.ok(html.includes(piece), `${where}: ${piece}`);
    }

    // Общая главная: прежний первый экран, плюс ссылки на страницы задач.
    for (const lang of LANGS) {
      const response = await get(lang === 'ka' ? '/?lang=ka' : '/' + lang);
      assert.equal(response.status, 200);
      const html = await response.text(), t = translate(lang);
      assert.match(html, /<body class="home-page font-sans /, `${lang}: the general homepage has no task mark`);
      assert.ok(html.includes(`<title>${t('site_title_index')}</title>`), `${lang}: general tab title`);
      assert.ok(html.includes(`<h1 class="home-hero-title">${t('home_hero_title')} <span>${t('home_hero_title_accent')}</span></h1>`) && html.includes(`<p class="home-hero-lead">${t('home_hero_lead_short')}</p>`), `${lang}: general headline and lead`);
      assert.ok(html.includes(`placeholder="${t('freeform_placeholder')}"`), `${lang}: general example in the form`);
      assert.doesNotMatch(html, /home-usp|home-article"|"serviceType"|"BreadcrumbList"/, `${lang}: nothing of a task page on the general homepage`);
      for (const page of [moving, cargo, junk]) assert.ok(html.includes(`<a href="${lang === 'ka' ? '' : '/' + lang}/s/${page.slug}">${page.content[lang].title} ${page.content[lang].accent}<i`), `${lang}: homepage links to ${page.slug}`);
      for (const other of LANGS) assert.ok(html.includes(`<link rel="alternate" hreflang="${other}" href="https://xtender.test${other === 'ka' ? '/' : '/' + other}">`), `${lang}: homepage hreflang ${other}`);
    }
    // Маленькая группа: фраза без числа и без кружков (на проде 2026-10-09 так вышла страница груза).
    const realGroup = orders.getDispatchRecipients;
    orders.getDispatchRecipients = async () => [{ id: 1, name: 'Avto' }, { id: 2, name: 'Beka' }];
    const small = await (await get('/ru/s/tvirtis-gadazidva')).text();
    orders.getDispatchRecipients = realGroup;
    assert.ok(small.includes('<span class="home-usp-post">Разместите пост в группе <b>водителей</b></span>'), 'a small group gets the phrase without a number');
    assert.doesNotMatch(small, /home-usp-avatars|home-usp-more/, 'and no circles');

    // Прежний параметр ?for= ничего не включает: страницы живут по своим адресам.
    assert.match(await (await get('/?lang=ka&for=moving')).text(), /<body class="home-page font-sans /);

    // Переадресации сохраняют метку клика рекламы.
    const location = async (url, cookie) => { const response = await get(url, cookie); assert.equal(response.status, 302, url); return response.headers.get('location'); };
    assert.equal(await location('/s/avejis-gadazidva?gclid=abc&utm_source=google', 'lang=ru'), '/ru/s/avejis-gadazidva?gclid=abc&utm_source=google', 'a remembered language keeps the click id');
    assert.equal((await get('/s/avejis-gadazidva?lang=ka&gclid=abc', 'lang=ru')).status, 200, 'an explicit Georgian link is not bounced');
    assert.equal((await get('/s/avejis-gadazidva?gclid=abc')).status, 200, 'a first visit gets the Georgian page');
    // Страница только на русском: с других языков ведёт на русскую версию, поисковикам объявлен один язык.
    assert.equal(await location('/s/test-page?gclid=abc'), '/ru/s/test-page?gclid=abc');
    assert.equal(await location('/en/s/test-page'), '/ru/s/test-page');
    const single = await (await get('/ru/s/test-page')).text();
    assert.ok(single.includes('<link rel="alternate" hreflang="ru" href="https://xtender.test/ru/s/test-page">') && single.includes('<link rel="alternate" hreflang="x-default" href="https://xtender.test/ru/s/test-page">'));
    assert.doesNotMatch(single, /hreflang="(ka|en)"/, 'languages the page does not have are not announced');
    assert.match(single, /<a href="https:\/\/xtender\.test\/\?lang=ka" aria-label="GE"/, 'the switch leads to the homepage for a missing language');
    // Выключенная страница ведёт на главную и не теряет метку; неизвестный адрес — 404.
    await landingPages.save(created.id, { ...draft(), is_active: false });
    assert.equal(await location('/ru/s/test-page?gclid=abc'), '/ru?gclid=abc');
    assert.equal(await location('/s/test-page?gclid=abc'), '/?gclid=abc&lang=ka');
    assert.equal((await get('/s/no-such-page')).status, 404);
    assert.equal((await get('/s/Bad_Slug')).status, 404);

    // 6. Карта сайта: постоянные страницы на трёх языках и включённые страницы задач.
    const sitemap = await get('/sitemap.xml');
    assert.match(sitemap.headers.get('content-type'), /xml/);
    const xml = await sitemap.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replace('https://xtender.test', ''));
    const three = suffix => [suffix, '/ru' + (suffix === '/' ? '' : suffix), '/en' + (suffix === '/' ? '' : suffix)];
    assert.deepEqual(locs, [...['/', '/join', '/terms', '/privacy', '/guides/request'].flatMap(three), ...[moving, cargo, junk].flatMap(page => three('/s/' + page.slug))]);
    assert.doesNotMatch(xml, /test-page/, 'a switched-off page is not in the sitemap');
    assert.equal((xml.match(/hreflang="x-default"/g) || []).length, locs.length, 'every address names its default version');
    assert.equal((await get('/ru/sitemap.xml')).status, 404, 'the sitemap has one address');
    assert.equal(sitemapXml([{ slug: 'only-ru', languages: ['ru'] }]).includes('<loc>https://xtender.test/s/only-ru</loc>'), false, 'a missing language is not listed');
    assert.ok(sitemapXml([{ slug: 'only-ru', languages: ['ru'] }]).includes('<xhtml:link rel="alternate" hreflang="x-default" href="https://xtender.test/ru/s/only-ru"/>'));
    assert.equal(fs.existsSync(path.join(root, 'public/sitemap.xml')), false, 'a static sitemap file would hide the generated one');

    // Сбой в страницах задач не роняет главную и карту сайта: они выходят без этих страниц.
    const realPublished = landingPages.published, quiet = console.error;
    require(servicePath).published = async () => { throw new Error('table is gone'); };
    console.error = () => {};
    const homeDuringFailure = await get('/?lang=ka');
    assert.equal(homeDuringFailure.status, 200, 'the homepage survives a landing-page failure');
    assert.doesNotMatch(await homeDuringFailure.text(), /class="home-task-links"/);
    const sitemapDuringFailure = await (await get('/sitemap.xml')).text();
    assert.ok(sitemapDuringFailure.includes('<loc>https://xtender.test/join</loc>') && !sitemapDuringFailure.includes('/s/'), 'the sitemap keeps the permanent pages');
    require(servicePath).published = realPublished; console.error = quiet;
  } finally {
    // Ответы, у которых проверялся только статус, держат соединение открытым: закрываем явно,
    // иначе процесс теста может не завершиться.
    server.close();
    server.closeAllConnections();
  }

  // 7. Админка: список, форма, сохранение с ошибкой и без, удаление.
  const controller = require('../src/controllers/landing.controller');
  const render = (view, locals) => ejs.renderFile(path.join(root, 'src/views', view + '.ejs'), { csrfToken: 'csrf', ...locals });
  const call = async (handler, req) => {
    const out = { statusCode: 200 };
    const res = { status(code) { out.statusCode = code; return res; }, send(body) { out.body = body; return res; }, redirect(url) { out.redirect = url; return res; },
      render(view, locals) { out.view = view; out.locals = locals; out.html = render(view, locals); return res; } };
    await handler({ params: {}, query: {}, body: {}, ...req }, res);
    if (out.html) out.html = await out.html;
    return out;
  };
  const listed = await call(controller.index);
  assert.equal(listed.view, 'admin/landings');
  assert.ok(listed.html.includes('xtender.ge/s/avejis-gadazidva') && listed.html.includes('В группе сейчас: <b>12</b>'), 'the list shows the address and the live number');
  assert.ok(listed.html.includes('href="/admin/landings/new"') && listed.html.includes('href="/ru/s/avejis-gadazidva"'));
  const editing = await call(controller.form, { params: { id: String(moving.id) } });
  assert.ok(editing.html.includes('name="content[ka][title]" value="ავეჯის გადაზიდვა"') && editing.html.includes('name="content[ru][post_one]"'), 'the form carries the saved texts');
  assert.doesNotMatch(editing.html, /name="content\[ka\]\[post_one\]"/, 'the extra Russian number form is asked only in Russian');
  assert.match(editing.html, /name="content\[ru\]\[article_on\]" checked/);
  assert.doesNotMatch(editing.html, /name="content\[ka\]\[article_on\]" checked/);
  assert.match(editing.html, /name="categories" value="movers" checked/);
  assert.ok((await call(controller.form)).html.includes('Новая страница'));
  assert.equal((await call(controller.form, { params: { id: '999999' } })).statusCode, 404);

  const body = { admin_name: 'Грузчики', slug: 'mushebi', categories: 'movers', is_active: 'on', sort_order: '40',
    content: { ka: { title: 'მუშები', accent: 'თბილისში', post: 'დადეთ პოსტი [{count} მუშის] ჯგუფში', post_plain: 'დადეთ პოსტი [მუშების] ჯგუფში', choose: 'და აირჩიეთ.', placeholder: 'მაგალითად: კარადა.', article: '## სათაური\nტექსტი', article_on: 'on' } } };
  const failed = await call(controller.save, { body: { ...body, slug: 'Mushebi!' } });
  assert.equal(failed.statusCode, 400);
  assert.ok(failed.html.includes('role="alert"') && failed.html.includes('value="მუშები"') && failed.html.includes('value="Mushebi!"'), 'an error keeps everything that was typed');
  const savedPage = await call(controller.save, { body });
  const mushebi = await landingPages.getBySlug('mushebi');
  assert.equal(savedPage.redirect, '/admin/landings/' + mushebi.id + '?saved=1');
  assert.deepEqual([mushebi.categories, mushebi.is_active, mushebi.content.ka.article_on, landingPages.languages(mushebi)], [['movers'], true, true, ['ka']]);
  const off = await call(controller.save, { params: { id: String(mushebi.id) }, body: { ...body, is_active: undefined, categories: undefined } });
  assert.equal(off.redirect, '/admin/landings/' + mushebi.id + '?saved=1');
  assert.deepEqual([(await landingPages.get(mushebi.id)).is_active, (await landingPages.get(mushebi.id)).categories], [false, []], 'unticked boxes are saved as off');
  assert.equal((await call(controller.remove, { params: { id: String(mushebi.id) } })).redirect, '/admin/landings?removed=1');
  assert.equal(await landingPages.getBySlug('mushebi'), null);
  const routes = fs.readFileSync(path.join(root, 'src/routes/admin.routes.js'), 'utf8');
  for (const line of routes.split('\n').filter(text => /router\.post\('\/landings/.test(text))) assert.match(line, /verifyCsrf/, 'every admin write is protected: ' + line.trim());
  assert.equal(routes.split('\n').filter(text => /router\.post\('\/landings/.test(text)).length, 3);

  // 8. Телефон: до нажатия остаётся одно поле, а правила полноэкранной формы прежние и сильнее.
  const css = fs.readFileSync(path.join(root, 'src/styles/input.css'), 'utf8');
  const phone = css.slice(css.indexOf('.home-topic .home-hero-layout'));
  assert.match(phone, /\.home-topic:not\(\.compose-active\) \.composer-toprow \{[^}]*clip:rect\(0,0,0,0\)/, 'the form heading is hidden visually, not removed');
  assert.match(phone, /\.home-topic \.composer-chips \{ display:none; \}/, 'service chips are not on the phone first screen');
  for (const selector of ['.composer-toprow', '#detailsStep', '.composer-inputbox', '.composer-textarea'])
    assert.ok(phone.includes(`.home-topic:not(.compose-active) ${selector} {`), `${selector}: the task-page rule must not apply inside the full-screen composer`);
  assert.match(css, /body\.compose-active #post-section \{\s*position: fixed; inset: 0;/, 'the full-screen composer rule is still there');
  assert.match(fs.readFileSync(path.join(root, 'src/views/index.ejs'), 'utf8'), /composeInput\.addEventListener\('focus', enterCompose\)/, 'tapping the field still opens the full-screen composer');
  // Таблица стоит выше места, с которого другой тест повторно читает schema.sql, и строк в ней файл не создаёт.
  const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  assert.ok(schema.indexOf('CREATE TABLE IF NOT EXISTS landing_pages') < schema.indexOf('-- Multiple provider services and immutable dispatch context.'));
  assert.doesNotMatch(schema, /INSERT INTO landing_pages/, 'schema.sql runs on every start and must not bring deleted pages back');

  console.log('PASS: task pages — seeded once, real dispatch counts, copy without promises, own addresses with search tags, redirects keep the ad click id, sitemap, admin section, same request form, general homepage unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
