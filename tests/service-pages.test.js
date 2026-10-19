// Автоматические страницы «услуга + город» (/s/mushebi-tbilisi): services/servicePages.service.js, маршрут
// /s/:slug и карта сайта в routes/public.routes.js, блок внизу в views/index.ejs. Проверяет то, что ломается
// незаметно: страница без исполнителей открыта поиску, число расходится с каталогом, адрес услуги из админки
// не собирается, страница задачи с тем же адресом перекрыта автоматической, город склоняется неверно.
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
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru' });

const servicePages = require('../src/services/servicePages.service');
const landingPages = require('../src/services/landingPage.service');
const { translate, normalizeLang } = require('../src/config/i18n');
const googleTag = require('../src/config/googleTag');
const PLACEHOLDERS = require('../src/config/service-pages-copy');
const ARTICLES = require('../src/config/service-pages-article');
const { FEATURE_TAGS } = require('../src/config/service-search-words');
const root = path.join(__dirname, '..');

let phones = 0;
async function insertMaster(services, city = 'tbilisi') {
  const phone = '+9955001' + String(10000 + ++phones);
  const master = (await pool.query(
    `INSERT INTO masters(name,phone,category,is_active,is_subscribed,balance_tetri,master_token,city_id)
     VALUES($1,$2,$3,true,true,1000,$4,(SELECT id FROM cities WHERE slug=$5)) RETURNING *`,
    ['Giorgi ' + phones, phone, services[0] === 'van' ? 'transport' : services[0], 'token-' + phone, city])).rows[0];
  for (const [index, service] of services.entries())
    await pool.query('INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,$2,$3::jsonb,$4)',
      [master.id, service, JSON.stringify(service === 'van' ? { size: 'L', body: 'closed' } : {}), index === 0]);
  await pool.query('UPDATE masters SET spoken_languages=$1::jsonb WHERE id=$2', [JSON.stringify(['ka', 'ru']), master.id]);
  return master;
}

function startSite() {
  const express = require('express');
  const app = express();
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
  // Адреса: встроенные услуги — запрос латиницей, услуга из админки — грузинское название латиницей.
  assert.equal(servicePages.serviceSlug({ slug: 'movers', name_ka: 'მუშები' }), 'mushebi');
  assert.equal(servicePages.serviceSlug({ slug: 'junk', name_ka: 'ნარჩენების გატანა' }), 'nagvis-gatana');
  assert.equal(servicePages.serviceSlug({ slug: 'svc_1', name_ka: 'სანტექნიკი', name_en: 'Plumbing' }), 'santekniki');
  assert.equal(servicePages.serviceSlug({ slug: 'svc_2', name_ka: 'ავტო ამწე!', name_en: 'x' }), 'avto-amtse');
  // «в городе» на трёх языках; по-грузински -ი → -ში.
  const tbilisi = { name_ka: 'თბილისი', name_ru: 'Тбилиси', name_en: 'Tbilisi' };
  assert.deepEqual(['ka', 'ru', 'en'].map(lang => servicePages.inCity(tbilisi, lang)), ['თბილისში', 'в Тбилиси', 'in Tbilisi']);
  assert.equal(servicePages.inCity({ name_ka: 'მცხეთა' }, 'ka'), 'მცხეთაში');

  // Каталог Тбилиси: 4 грузчика (один ещё и вывозит мусор), 1 перевозка, 3 сантехника из админки;
  // эвакуаторов нет; грузчик в выключенном Батуми не считается.
  await pool.query(`INSERT INTO service_categories(slug,name_ka,name_ru,name_en,icon,fields,is_builtin,sort_order)
    VALUES('svc_plumb','სანტექნიკი','Сантехники','Plumbing','','[]',false,50)`);
  for (let i = 0; i < 3; i++) await insertMaster(['movers']);
  // Один грузчик пишет о сборке мебели — на странице особенность «сборка мебели — 1».
  await pool.query("UPDATE masters SET description='Погрузка, собираю и разбираю мебель' WHERE id=(SELECT MIN(id) FROM masters)");
  await insertMaster(['movers', 'junk']);
  await insertMaster(['van']);
  for (let i = 0; i < 3; i++) await insertMaster(['svc_plumb']);
  await pool.query("INSERT INTO master_cities(master_id, city_id) VALUES ((SELECT MAX(id) FROM masters), (SELECT id FROM cities WHERE slug='tbilisi'))");
  const batumi = await insertMaster(['movers'], 'batumi');
  await pool.query("INSERT INTO master_cities(master_id, city_id) VALUES ($1, (SELECT id FROM cities WHERE slug='batumi'))", [batumi.id]);

  const published = await servicePages.published();
  assert.deepEqual(published.map(page => [page.slug, page.count]).sort(), [['mushebi-tbilisi', 4], ['santekniki-tbilisi', 3]], 'only services with at least three providers are open to search');
  assert.equal(servicePages.MIN_PROVIDERS, 3);

  const server = await startSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  try {
    // Страница на трёх языках: свой заголовок, h1, описание с настоящим числом, canonical, три языка.
    for (const [url, lang, h1] of [['/s/mushebi-tbilisi?lang=ka', 'ka', 'მუშები თბილისში'], ['/ru/s/mushebi-tbilisi', 'ru', 'Грузчики в Тбилиси'], ['/en/s/mushebi-tbilisi', 'en', 'Movers in Tbilisi']]) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
      const html = await response.text(), t = translate(lang);
      assert.ok(html.includes(`<title>${h1} | xtender.ge</title>`), `${lang}: tab title`);
      assert.ok(html.includes(`<h1 id="simple-seo-title">${h1}</h1>`) && (html.match(/<h1[ >]/g) || []).length === 1, `${lang}: one h1`);
      assert.ok(html.includes(`<meta name="description" content="${t('seo_auto_description').replace('{h1}', h1).replace('{n}', 4)}">`), `${lang}: description with the real number`);
      assert.doesNotMatch(html, /noindex/, `${lang}: open to search`);
      const own = lang === 'ka' ? '/s/mushebi-tbilisi' : `/${lang}/s/mushebi-tbilisi`;
      assert.ok(html.includes(`<link rel="canonical" href="https://xtender.test${own}">`), `${lang}: canonical`);
      for (const other of ['ka', 'ru', 'en']) assert.ok(html.includes(`hreflang="${other}" href="https://xtender.test${other === 'ka' ? '' : '/' + other}/s/mushebi-tbilisi"`), `${lang}: hreflang ${other}`);
      assert.ok(html.includes(`placeholder="${PLACEHOLDERS.movers[lang]}"`), `${lang}: the example fits the service`);
      assert.ok(html.includes(`"@type":"Service","name":"${h1}"`), `${lang}: Service markup`);
      assert.ok(html.includes(`"preset":{"key":"movers","label":"#`), `${lang}: the service hashtag is pressed on open`);
      // Живое число — только исполнители услуги, а не весь каталог; рядом другие услуги города.
      assert.ok(html.includes('<p>' + t('seo_now_count').replace('{n}', 4).split('{city}')[0]), `${lang}: four movers`);
      assert.ok(html.includes(`/s/santekniki-tbilisi">${lang === 'ka' ? 'სანტექნიკი თბილისში' : lang === 'ru' ? 'Сантехники в Тбилиси' : 'Plumbing in Tbilisi'}<i`), `${lang}: link to the other open page`);
      assert.doesNotMatch(html, /\/s\/nagvis-gatana-tbilisi"/, `${lang}: no link to a page closed to search`);
      // Карточки услуги — первыми.
      const services = [...html.matchAll(/class="master-card [^"]*"[^>]*data-services="([^"]*)"/g)].map(match => match[1]);
      assert.deepEqual(services.slice(0, 4).map(list => list.includes('movers')), [true, true, true, true], `${lang}: movers first`);
      // Свой текст грузчиков: статья вместо общих «Как это работает» и «Чем удобнее», свои вопросы и в разметке, и
      // внизу, ссылка для ищущих работу, особенность из описания с настоящим числом.
      const copy = ARTICLES.movers[lang];
      assert.ok(html.includes(`<h2>${copy.article[0].h}</h2>`) && !html.includes(`<h2>${t('seo_how_title')}</h2>`), `${lang}: own article instead of the general one`);
      assert.ok(html.includes(`"@type":"Question","name":"${copy.faq[0].q}"`) && html.includes(`<h3>${copy.faq[0].q}</h3>`), `${lang}: own questions in markup and on the page`);
      assert.ok(!html.includes(`"name":"${t('faq_q5')}"`), `${lang}: general questions are not in the markup`);
      assert.ok(html.includes(`<a href="${lang === 'ka' ? '' : '/' + lang}/join">${copy.join.cta}</a>`), `${lang}: link for job seekers`);
      const assembly = FEATURE_TAGS.find(tag => tag.key === 'assembly').tag[lang];
      assert.ok(html.includes(`<strong>${t('seo_auto_features')}:</strong> ${assembly} — 1.`), `${lang}: furniture assembly counted from the description`);
    }

    // Один исполнитель — страница открывается, но закрыта от поиска; ни одного — 404; выключенный город — 404.
    const junk = await get('/en/s/nagvis-gatana-tbilisi');
    assert.equal(junk.status, 200);
    const junkHtml = await junk.text();
    assert.match(junkHtml, /<meta name="robots" content="noindex, nofollow">/);
    // У услуги без своего текста — общий текст и общие вопросы, как раньше.
    assert.ok(junkHtml.includes(`<h2>${translate('en')('seo_how_title')}</h2>`) && junkHtml.includes(`"name":"${translate('en')('faq_q5')}"`), 'a service without its own copy keeps the general text');
    for (const url of ['/ru/s/evakuatori-tbilisi', '/ru/s/mushebi-batumi', '/ru/s/nothing-tbilisi', '/s/mushebi-tbilisi-extra'])
      assert.equal((await get(url)).status, 404, url);

    // Запомненный язык уводит на свою версию, как у остальных страниц.
    const remembered = await get('/s/mushebi-tbilisi', 'lang=ru');
    assert.equal(remembered.status, 302);
    assert.equal(remembered.headers.get('location'), '/ru/s/mushebi-tbilisi');

    // Главная ссылается на открытые поиску страницы услуг; карта сайта их перечисляет на трёх языках.
    const home = await (await get('/ru')).text();
    assert.ok(home.includes('<a href="/ru/s/mushebi-tbilisi">Грузчики в Тбилиси<i') && home.includes('<a href="/ru/s/santekniki-tbilisi">Сантехники в Тбилиси<i'), 'homepage links');
    assert.doesNotMatch(home, /nagvis-gatana-tbilisi/, 'no link to a closed page');
    const xml = await (await get('/sitemap.xml')).text();
    for (const slug of ['mushebi-tbilisi', 'santekniki-tbilisi'])
      for (const prefix of ['', '/ru', '/en']) assert.ok(xml.includes(`<loc>https://xtender.test${prefix}/s/${slug}</loc>`), prefix + slug);
    assert.doesNotMatch(xml, /nagvis-gatana-tbilisi/);

    // Страница задачи из админки с тем же адресом важнее: автоматическая не показывается и не дублируется.
    await landingPages.save(null, { slug: 'mushebi-tbilisi', admin_name: 'Грузчики', categories: ['movers'], is_active: 'on', sort_order: '5',
      content: { ru: { title: 'Грузчики', accent: 'в Тбилиси', post: 'В группе [{count} грузчиков]', post_plain: 'В группе [грузчиков]', choose: 'и выберите.', placeholder: 'Например: шкаф.' } } });
    assert.match(await (await get('/ru/s/mushebi-tbilisi')).text(), /<p class="simple-seo-lead">В группе <b>/, 'the task page wins');
    const xmlAfter = await (await get('/sitemap.xml')).text();
    assert.equal((xmlAfter.match(/<loc>https:\/\/xtender\.test\/ru\/s\/mushebi-tbilisi<\/loc>/g) || []).length, 1, 'listed once');
    assert.equal((await servicePages.published(new Set(['mushebi-tbilisi']))).length, 1);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  console.log('PASS: service pages — addresses for built-in and admin services, city forms, threshold of three, noindex below it, 404 without providers, three languages with canonical and hreflang, live number of the service, own article and questions for movers, homepage links, sitemap, a task page with the same address wins');
})().catch(error => { console.error(error); process.exit(1); });
