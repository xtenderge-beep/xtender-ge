// Мини-страницы компаний (docs/company-pages.md): у каждой компании из списка обзвона — адрес и закрытый предпросмотр;
// адрес из домена сайта, без повторов; предпросмотр — noindex, без canonical; ссылка на анкету кладёт адрес в черновик;
// после подтверждения адрес переходит исполнителю (если свободен); публичная страница — только у активного,
// не тестового, не заблокированного; три языка с hreflang и разметкой; одобренные отзывы и средняя оценка;
// страница в карте сайта; номер компании на странице не показывается; один язык на странице (районы, доп. услуги,
// описание); короткий ответ сверху, вопросы-ответы с разметкой, похожие компании; кнопка заявки помечена компанией.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (p, exports) => require.cache[require.resolve(p)] = { exports };
stub('../src/config/db', pool); stub('../src/config/redis', new (require('ioredis-mock'))());
stub('../src/services/sms.service', { sendOtp: async () => ({ providerMessageId: 'x', messageBody: 'c' }), sendOrderNotification: async () => ({ ok: true }) });
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru', translateText: async () => null, translateProviderDescription: async () => null });
stub('../src/services/telegram.service', { notifyModeratorNewMaster: async () => {}, notifyModerator: async () => {}, sendToChat: async () => {}, updateMessage: async () => {} });
process.env.DOMAIN = 'xtender.ge';

const ejs = require('ejs');
const prospects = require('../src/services/prospect.service');
const pages = require('../src/services/companyPage.service');
const { buildSeo, sitemapXml } = require('../src/config/seo');
const render = (locals) => ejs.renderFile(path.join(__dirname, '../src/views/company.ejs'), locals);

(async () => {
  const r = await prospects.importMany([
    { name: 'avejisgadazidva.ge', phone: '599962596', website: 'https://avejisgadazidva.ge/', services: ['movers', 'transport'], other_services: ['упаковка', 'пианино/сейф'],
      description: 'ავეჯის გადაზიდვა თბილისში და მთელ საქართველოში.' },
    { name: 'Avejis Gadazidva 2', phone: '599000001', website: 'https://avejisgadazidva.com/', services: ['junk'] },
    { name: 'ნაგვის გატანა', phone: '599000002', services: ['junk'] },
  ], { source: 'test' });
  assert.equal(r.created, 3);
  const all = (await prospects.list()).rows;
  const [a, b, c] = ['avejisgadazidva.ge', 'Avejis Gadazidva 2', 'ნაგვის გატანა'].map(n => all.find(x => x.name === n));
  assert.equal(a.slug, 'avejisgadazidva'); assert.equal(b.slug, 'avejisgadazidva-2', 'адрес не повторяется');
  assert.match(c.slug, /^nagvis-gatana/, 'без сайта — из названия латиницей');
  assert.match(a.preview_token, /^[a-z2-9]{20}$/);

  // Предпросмотр: три языка, noindex, без canonical, без номера.
  for (const lang of ['ka', 'ru', 'en']) {
    const m = await pages.byPreviewToken(a.preview_token, lang);
    assert.equal(m.preview, true); assert.equal(m.items.length, 2, 'грузчики + перевозки');
    const html = await render({ c: m, seo: null, langHref: code => '?lang=' + code });
    assert.ok(html.includes('noindex') && !html.includes('rel="canonical"') && !html.includes('application/ld+json'));
    assert.ok(!html.includes('599962596') && !html.includes('599 96'), 'номера нет');
    assert.ok(html.includes(m.copy.previewBanner) && html.includes(m.copy.cta));
  }
  // Один язык: грузинское описание с сайта — только на грузинской странице; доп. услуги — на языке страницы.
  const ka = await pages.byPreviewToken(a.preview_token, 'ka'), ru = await pages.byPreviewToken(a.preview_token, 'ru');
  assert.equal(ka.intro, 'ავეჯის გადაზიდვა თბილისში და მთელ საქართველოში.');
  assert.ok(!/[\u10A0-\u10FF]/.test(ru.intro), 'на русской странице нет грузинского описания: ' + ru.intro);
  assert.deepEqual(ka.extras, ['შეფუთვა', 'პიანინო და სეიფი']); assert.deepEqual(ru.extras, ['упаковка', 'пианино и сейфы']);
  assert.ok(ka.summary.startsWith('avejisgadazidva.ge — ') && ka.faq.length === 5);
  assert.ok(!ka.ctaHref.includes('?company='), 'предпросмотр: компания ещё не принимает заявки');
  assert.equal(pages.model({ name: 'X', services: ['junk'], other_services: ['вывоз пианино'], lang: 'en' }).extras.length, 0, 'незнакомое слово другим алфавитом не показываем');
  assert.equal(pages.isIndexable('s'.repeat(130), 0), true, 'длина описания считается по знакам');
  assert.equal(await pages.byPreviewToken('wrong'), null);
  assert.equal(await pages.byPreviewToken('a'.repeat(20)), null);

  // Ссылка на анкету кладёт адрес в черновик.
  await prospects.createLink(a.id, { confirmedByOwner: true });
  const draft = (await pool.query("SELECT data FROM provider_drafts WHERE phone = '+995599962596'")).rows[0];
  assert.equal((typeof draft.data === 'string' ? JSON.parse(draft.data) : draft.data).slug, 'avejisgadazidva');

  // Подтвердил: адрес переходит исполнителю. Пока не активен — страницы нет.
  const m = (await pool.query("INSERT INTO masters (name, phone, is_active, category, description, signup_hint) VALUES ('AG', '+995599962596', false, 'movers', 'Перевозим мебель аккуратно.', $1) RETURNING id",
    [JSON.stringify({ other_services: ['упаковка'] })])).rows[0];
  await pool.query("INSERT INTO master_services (master_id, service_type) VALUES ($1, 'movers'), ($1, 'van')", [m.id]);
  assert.equal(await pages.claimSlug(m.id, 'avejisgadazidva'), 'avejisgadazidva');
  assert.equal(await pages.claimSlug(m.id + 1000, 'avejisgadazidva'), null, 'чужой адрес не забрать');
  assert.equal(await pages.bySlug('avejisgadazidva', 'ru'), null, 'не активен — страницы нет');
  await pool.query('UPDATE masters SET is_active = true WHERE id = $1', [m.id]);

  // Отзывы: только одобренные.
  const order = (await pool.query("INSERT INTO orders (phone, description, status, token) VALUES ('+995555000000', 'x', 'closed', 'tok-a') RETURNING id")).rows[0];
  const order2 = (await pool.query("INSERT INTO orders (phone, description, status, token) VALUES ('+995555000001', 'y', 'closed', 'tok-b') RETURNING id")).rows[0];
  await pool.query("INSERT INTO master_reviews (master_id, order_id, rating, comment, is_approved) VALUES ($1, $2, 5, 'Отлично!', true), ($1, $3, 1, 'спам', false)", [m.id, order.id, order2.id]);

  const pub = await pages.bySlug('avejisgadazidva', 'ru');
  assert.equal(pub.preview, false); assert.equal(pub.reviews.length, 1); assert.equal(pub.avg, 5);
  assert.equal(pub.intro, 'Перевозим мебель аккуратно.'); assert.deepEqual(pub.items.map(i => i.code), ['movers', 'van']);
  assert.equal(pub.ctaHref, '/ru/s/mushebi-tbilisi?company=avejisgadazidva', 'заявка с кнопки помечена компанией');
  const pubKa = await pages.bySlug('avejisgadazidva', 'ka');
  assert.ok(!/[\u0400-\u04FF]/.test(pubKa.intro + pubKa.extras.join() + pubKa.languages.join()), 'на грузинской странице нет русского: ' + pubKa.intro);
  await pool.query('UPDATE masters SET description_translations = $2 WHERE id = $1', [m.id, JSON.stringify({ ka: 'ავეჯს ფრთხილად ვზიდავთ.' })]);
  assert.equal((await pages.bySlug('avejisgadazidva', 'ka')).intro, 'ავეჯს ფრთხილად ვზიდავთ.', 'перевод описания на язык страницы');
  const seo = buildSeo('ru', '/company/avejisgadazidva');
  const html = await render({ c: pub, seo, langHref: code => seo.alternates[code] });
  assert.ok(html.includes('rel="canonical" href="https://xtender.ge/ru/company/avejisgadazidva"'));
  assert.ok(html.includes('hreflang="ka" href="https://xtender.ge/company/avejisgadazidva"') && html.includes('hreflang="en"'));
  assert.ok(html.includes('"@type":"MovingCompany"') && html.includes('"ratingValue":5'));
  assert.ok(html.includes('Отлично!') && !html.includes('спам'));
  assert.ok(!html.includes('noindex'), 'есть одобренный отзыв — страница открыта поиску');
  assert.ok(html.includes('<title>AG: Грузчики, Перевозка на машине в Тбилиси — отзывы, цены | xtender.ge</title>'), html.match(/<title>.*<\/title>/)[0]);
  assert.ok(html.includes('"@type":"BreadcrumbList"') && html.includes('aria-label="breadcrumb"'), 'хлебные крошки и их разметка');
  assert.ok(/На xtender\.ge с \S+ \d{4}/.test(html), 'на xtender с месяца года');
  assert.ok(html.includes('Номер подтверждён кодом из SMS') && html.includes('Проверено модератором'));
  assert.deepEqual(pub.dist.map(d => d.n), [1, 0, 0, 0, 0], 'разбивка по звёздам');
  assert.ok(pub.metaDescription.includes('Оценка 5 (1)'), pub.metaDescription);
  assert.ok(pub.summary.includes('AG — ') && pub.summary.includes('Оценка 5 из 5'), pub.summary);
  assert.ok(html.includes('"@type":"FAQPage"') && html.includes('Сколько стоят услуги AG?'), 'вопросы-ответы и их разметка');
  assert.ok(html.includes('data-summary'), 'короткий ответ под названием');

  // Порог качества: без отзывов и с коротким описанием — noindex и не в карте сайта; длинное своё описание — открыта.
  await pool.query('UPDATE master_reviews SET is_approved = false WHERE master_id = $1', [m.id]);
  const thin = await pages.bySlug('avejisgadazidva', 'ru');
  assert.equal(thin.indexable, false);
  const thinHtml = await render({ c: thin, seo, langHref: code => seo.alternates[code] });
  assert.ok(thinHtml.includes('noindex') && !thinHtml.includes('rel="canonical"'));
  assert.deepEqual(await pages.published(), []);
  await pool.query('UPDATE masters SET description = $2, signup_hint = $3 WHERE id = $1', [m.id, 'Перевозим мебель по Тбилиси с 2015 года. Своя бригада из шести грузчиков, две машины с закрытым кузовом, разборка и сборка шкафов, упаковка в плёнку и картон.', JSON.stringify({ other_services: ['упаковка'], districts: ['Сабуртало', 'Ваке'] })]);
  const rich = await pages.bySlug('avejisgadazidva', 'ru');
  assert.equal(rich.indexable, true); assert.deepEqual(rich.districts, ['Сабуртало', 'Ваке']);
  assert.ok((await render({ c: rich, seo, langHref: code => seo.alternates[code] })).includes('Сабуртало, Ваке'));
  assert.deepEqual((await pages.bySlug('avejisgadazidva', 'ka')).districts, ['საბურთალო', 'ვაკე'], 'районы на языке страницы');

  // Похожие компании: только опубликованные (порог качества) с общей услугой.
  const other = (await pool.query("INSERT INTO masters (name, phone, is_active, category, description, public_slug) VALUES ('Movers Two', '+995599000777', true, 'movers', $1, 'movers-two') RETURNING id", ['Перевозки и грузчики по всему Тбилиси, работаем без выходных, своя машина и бригада из четырёх человек, разборка мебели и упаковка.'])).rows[0];
  await pool.query("INSERT INTO master_services (master_id, service_type) VALUES ($1, 'movers')", [other.id]);
  const thinOne = (await pool.query("INSERT INTO masters (name, phone, is_active, category, description, public_slug) VALUES ('Thin', '+995599000778', true, 'movers', 'коротко', 'thin') RETURNING id")).rows[0];
  await pool.query("INSERT INTO master_services (master_id, service_type) VALUES ($1, 'movers')", [thinOne.id]);
  const withSimilar = await pages.bySlug('avejisgadazidva', 'ru');
  assert.deepEqual(withSimilar.similar.map(x => x.href), ['/ru/company/movers-two']);
  assert.ok((await render({ c: withSimilar, seo, langHref: code => seo.alternates[code] })).includes('href="/ru/company/movers-two"'));
  await pool.query('UPDATE masters SET public_slug = NULL WHERE id IN ($1, $2)', [other.id, thinOne.id]);

  // Тестовый или заблокированный — страницы нет.
  await pool.query('UPDATE masters SET is_technical = true WHERE id = $1', [m.id]);
  assert.equal(await pages.bySlug('avejisgadazidva', 'ka'), null);
  assert.deepEqual(await pages.published(), []);
  await pool.query('UPDATE masters SET is_technical = false WHERE id = $1', [m.id]);
  assert.deepEqual(await pages.published(), ['avejisgadazidva']);
  assert.equal(await pages.bySlug('../etc', 'ka'), null);

  // Карта сайта.
  const xml = sitemapXml([{ path: '/company/avejisgadazidva', languages: ['ka', 'ru', 'en'] }]);
  assert.ok(xml.includes('<loc>https://xtender.ge/company/avejisgadazidva</loc>') && xml.includes('<loc>https://xtender.ge/en/company/avejisgadazidva</loc>'));
  console.log('company-pages: OK');
})().catch(e => { console.error(e); process.exit(1); });
