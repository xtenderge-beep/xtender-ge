const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const redis = new (require('ioredis-mock'))();
require.cache[require.resolve('../src/config/redis')] = { exports: redis };

const { detectLang } = require('../src/services/translation.service');
const requestLanguage = require('../src/config/requestLanguage');
const { translate, clientStrings } = require('../src/config/i18n');
const { buildSeo } = require('../src/config/seo');

const RU_TEXT = 'Нужен переезд с Ваке на Сабуртало, 2-комнатная квартира, 5 этаж';
const KA_TEXT = 'მჭირდება გადასახლება ვაკედან საბურთალოზე, 2-ოთახიანი ბინა';
const EN_TEXT = 'Need a move from Vake to Saburtalo, 2-bedroom apartment';

(async () => {
  // --- Определение языка: по преобладающему алфавиту, а не по «хоть одной букве».
  assert.equal(detectLang(RU_TEXT), 'ru');
  assert.equal(detectLang(KA_TEXT), 'ka');
  assert.equal(detectLang(EN_TEXT), 'en');
  assert.equal(detectLang('Переезд с улицы ვაჟა-ფშაველა, 3 этаж, без лифта'), 'ru', 'russian text with one georgian street name stays russian');
  assert.equal(detectLang('მჭირდება ევაკუატორი, Vake, iPhone'), 'ka', 'georgian text with latin brand names stays georgian');
  assert.equal(detectLang('12345 ---'), 'en', 'no letters at all keeps the old default');
  assert.equal(detectLang(''), 'en');
  assert.equal(detectLang(null), 'en');

  assert.equal(requestLanguage.ofOrder({ description: RU_TEXT, source_lang: 'ka' }), 'ru', 'language comes from the text, not from a stale source_lang');
  assert.equal(requestLanguage.ofOrder({ description: KA_TEXT, source_lang: null }), 'ka', 'works when translation never ran (source_lang is NULL)');
  assert.equal(requestLanguage.ofOrder({ description: '   ' }), null);
  assert.equal(requestLanguage.ofOrder(null), null);

  // --- Совет «пишите на языке заявки»: только известному исполнителю без этого языка.
  const onlyKa = { spoken_languages: ['ka'], language: 'ru' };
  assert.equal(requestLanguage.needsAdvice('ru', onlyKa), true, 'georgian-only provider + russian request');
  assert.equal(requestLanguage.needsAdvice('ka', onlyKa), false, 'same language: nothing to say');
  assert.equal(requestLanguage.needsAdvice('ru', { spoken_languages: ['ka', 'ru'] }), false, 'provider speaks both');
  assert.equal(requestLanguage.needsAdvice('en', { spoken_languages: ['tr', 'az'] }), true, 'languages beyond ka/ru/en are respected');
  assert.equal(requestLanguage.needsAdvice('ru', { spoken_languages: [], language: 'ka' }), true, 'empty profile falls back to the cabinet language');
  assert.equal(requestLanguage.needsAdvice('ru', { spoken_languages: [], language: 'ru' }), false);
  assert.equal(requestLanguage.needsAdvice('ru', { spoken_languages: [], language: null }), false, 'nothing known about the provider: stay silent');
  assert.equal(requestLanguage.needsAdvice('ru', null), false, 'no ?master= (moderator, stray link): no advice');
  assert.equal(requestLanguage.needsAdvice(null, onlyKa), false);

  // --- Контроллер: язык заявки и совет попадают в render.
  const orderService = require('../src/services/order.service');
  const masterService = require('../src/services/master.service');
  const settingsService = require('../src/services/settings.service');
  const controller = require('../src/controllers/order.controller');
  require('../src/services/serviceMatching.service').openMatches = async()=>['movers'];
  let order = { id: 7, token: 'lang-tok-1', owner_token: 'owner-x', phone: '+995500000010', description: RU_TEXT, status: 'new',
    district_name: '', target_categories: ['movers'], source_lang: null, description_translations: {}, created_at: new Date() };
  let master = { id: 5, name: 'Гела', category: 'movers', master_token: 'mt-5', balance_tetri: 500, is_banned: false, spoken_languages: ['ka'], language: 'ka' };
  orderService.getOrderByToken = async () => order;
  orderService.getOrderFiles = async () => [];
  orderService.getClosedCategories = async () => [];
  orderService.getOrderFunnelStats = async () => ({ view: 0, call: 0, whatsapp: 0 });
  masterService.getMasterById = async () => master;
  masterService.getMasterByToken = async () => master;
  const masterSession = require('../src/services/masterSession.service');
  masterSession.token = async req => req.cookies.testSession ? 'mt-5' : null;
  settingsService.getLeadPriceTetri = async () => 50;
  const call = async (query, cookies = {}) => {
    const res = { set() {}, render(view, data) { this.data = data; return this; } };
    if (query.master) cookies = { ...cookies, testSession: true };
    await controller.show({ params: { token: order.token }, query, cookies, lang: 'ka' }, res);
    return res.data;
  };

  let data = await call({ master: '5' });
  assert.equal(data.requestLang, 'ru');
  assert.equal(data.langAdvice, true, 'georgian-only provider opens a russian request');
  assert.ok(data.whatsappText.startsWith('Здравствуйте!'), 'whatsapp greeting is in the request language even with NULL source_lang');

  order = { ...order, description: KA_TEXT };
  data = await call({ master: '5' });
  assert.equal(data.requestLang, 'ka');
  assert.equal(data.langAdvice, false);
  assert.ok(data.whatsappText.startsWith('გამარჯობა!'), 'georgian request gets the georgian greeting (used to fall back to russian)');

  order = { ...order, description: RU_TEXT };
  data = await call({});
  assert.equal(data.requestLang, 'ru', 'label is shown to anyone who is not the owner');
  assert.equal(data.langAdvice, false, 'but the advice needs a known provider');

  data = await call({ master: '5' }, { ['order_' + order.token]: order.owner_token });
  assert.equal(data.requestLang, null, 'owner wrote it himself: no label');
  assert.equal(data.langAdvice, false);

  // --- Страница: метка и совет на трёх языках, старой серой строки больше нет.
  const renderOrder = (lang, locals) => ejs.renderFile(path.join(__dirname, '../src/views/order.ejs'), {
    lang, t: translate(lang), clientStrings: clientStrings(lang), currentPath: '/', isRememberedProvider: false, csrfToken: 'test',
    seo: buildSeo(lang, '/'), order: { ...order, description: RU_TEXT }, files: [], isOwner: false, masterId: 5, masterCategory: 'movers',
    funnel: null, masterAccount: null, targetCategories: ['movers'], closedCategories: [], categoryLabels: {}, whatsappText: 'x',
    createdMinutesAgo: 1, revisionCopy: { title: '' }, revisionCsrf: 'x', ...locals,
  });
  const shown = (html, text) => html.includes('>' + ejs.escapeXML(text) + '<');
  for (const lang of ['ka', 'ru', 'en']) {
    const t = translate(lang);
    const withAdvice = await renderOrder(lang, { requestLang: 'ru', langAdvice: true });
    assert.ok(withAdvice.includes(ejs.escapeXML(t('order_lang_label')) + ': <span class="text-stone-800">' + ejs.escapeXML(t('order_lang_ru')) + '</span>'), `${lang}: label names the request language`);
    assert.ok(shown(withAdvice, t('order_lang_advice')), `${lang}: advice is shown`);
    assert.ok(withAdvice.indexOf('id="langAdvice"') < withAdvice.indexOf('id="callBtn"'), `${lang}: advice comes before the call / WhatsApp buttons`);
    assert.ok(!withAdvice.includes('order_lang_hint'), `${lang}: no leftover key`);

    const noAdvice = await renderOrder(lang, { requestLang: 'ru', langAdvice: false });
    assert.ok(noAdvice.includes(ejs.escapeXML(t('order_lang_label'))), `${lang}: label stays without advice`);
    assert.ok(!noAdvice.includes('id="langAdvice"'), `${lang}: no advice block when the provider speaks the language`);

    const owner = await renderOrder(lang, { isOwner: true, funnel: { view: 0, call: 0, whatsapp: 0 }, requestLang: null, langAdvice: false });
    assert.ok(!owner.includes(ejs.escapeXML(t('order_lang_label')) + ':'), `${lang}: owner sees no language label`);

    // Экран без новых локалей (например, рендер 404/другой путь) не должен падать.
    await renderOrder(lang, { requestLang: undefined, langAdvice: undefined });
    for (const code of ['ka', 'ru', 'en']) assert.ok(t('order_lang_' + code) !== 'order_lang_' + code, `${lang}: name of ${code} is translated`);
  }

  // --- Telegram-лид: рамка на языке исполнителя + строка «Язык заявки».
  const telegram = require('../src/services/telegram.service');
  const lead = (m, description, extra = {}) => telegram.leadMessage(m, { id: 12, description, district_name: 'Ваке', is_technical: false, ...extra });
  let msg = lead({ language: 'ka' }, RU_TEXT);
  assert.ok(msg.text.startsWith('🆕 განაცხადი #12'), 'georgian provider gets a georgian frame');
  assert.ok(msg.text.includes(RU_TEXT), 'the request text is the original, untouched');
  assert.ok(msg.text.includes('💬 განაცხადის ენა: რუსული'), 'and the language of the request is named');
  assert.equal(msg.openLabel, '📄 განაცხადის გახსნა');
  msg = lead({ language: 'ru' }, KA_TEXT);
  assert.ok(msg.text.startsWith('🆕 Заявка #12'));
  assert.ok(msg.text.includes('💬 Язык заявки: грузинский'));
  assert.ok(msg.text.includes('📍 Ваке'));
  msg = lead({ language: 'en' }, RU_TEXT);
  assert.ok(msg.text.includes('💬 Request language: Russian'));
  assert.equal(msg.openLabel, '📄 Open request');
  msg = lead({}, RU_TEXT, { is_technical: true });
  assert.ok(msg.text.startsWith('🧪 ТЕСТ · 🆕 Заявка #12'), 'no stored language: the frame stays russian as before; technical marker kept');
  msg = lead({ language: 'ru' }, '   ');
  assert.ok(!msg.text.includes('Язык заявки'), 'no text, no language line');

  console.log('order-language.test.js: all assertions passed');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); }).finally(() => redis.disconnect());
