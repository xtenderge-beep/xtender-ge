// Каталог как данные и подбор по параметрам (docs/api-v1/WORKFLOWS.md, раздел «Подбор»), в песочнице (XTENDER_SANDBOX=1):
// 1. Клининг создаётся в админке (форма редактора), находится по синонимам в ChatGPT (инструменты MCP) и проходит весь путь
//    до предложения исполнителя без правок плагина; подбор — по параметрам заказчика.
// 2. Перевозка 18 тонн подбирает машины с подтверждённой грузоподъёмностью от 18 т — числом, не классом кузова; меньшие и
//    неизвестные не получают заявку; у исполнителя с двумя машинами хватает одной подходящей.
// 3. Оценка, экран модератора и рассылка считают одинаково; ручная правка требований — в журнале.
// 4. Изменение схемы после сохранения черновика: устаревшие данные не проходят публикацию, перечень исправлений.
// 5. Описания и синонимы — в базе (перенос из кода, правка меняет версию каталога); единицы — только из справочника.
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.DEAL_WORKER = 'manual';
const harness = require('./api-v1-harness');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { pool } = harness;
const SCOPES = 'profile:read profile:write tenders:read tenders:write offers:read offers:write messages:read messages:write notifications:write';
const day = 24 * 60 * 60 * 1000;
const categories = require('../src/services/category.service');
const dispatch = require('../src/services/dispatch.service');

(async () => {
  const { server, base } = await harness.start();
  // Редактор категорий — тот же обработчик, что /admin/categories (без входа администратора: он проверяется до него).
  const express = require('express');
  const admin = express();
  admin.use(express.urlencoded({ extended: true }));
  admin.set('view engine', 'ejs');
  admin.set('views', path.join(__dirname, '../src/views'));
  admin.use((req, res, next) => { res.locals.csrfToken = 'test'; res.locals.navCounts = {}; next(); });
  const categoryController = require('../src/controllers/category.controller');
  admin.post('/admin/categories', require('../src/middleware/asyncHandler')(categoryController.save));
  admin.post('/admin/categories/:slug', require('../src/middleware/asyncHandler')(categoryController.save));
  const adminServer = await new Promise((resolve) => { const s = admin.listen(0, '127.0.0.1', () => resolve(s)); });
  const adminBase = 'http://127.0.0.1:' + adminServer.address().port;
  const postForm = async (url, fields) => fetch(adminBase + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const connect = async (token) => {
    const client = new Client({ name: 'chatgpt-like', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), token ? { requestInit: { headers: { authorization: 'Bearer ' + token } } } : {}));
    return client;
  };
  const ok = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  const call = harness.client(base);
  const accessOf = async (orderId) => (await pool.query('SELECT master_id FROM order_access WHERE order_id=$1 ORDER BY master_id', [orderId])).rows.map((r) => r.master_id);
  async function publishWithConsent(client, draft) {
    const first = await client.callTool({ name: 'publish_tender', arguments: { tender_id: draft.id, version: draft.version, confirmed_by_user: true } });
    if (first.structuredContent?.error?.code === 'CONSENT_REQUIRED') {
      const bundle = await require('../src/services/consent.service').bundle('client', 'ru');
      await require('../src/services/accountConsent.service').accept(first.structuredContent.error.consent_url.split('/').pop(), { bundle, sms: false });
      return ok(client, 'publish_tender', { tender_id: draft.id, version: draft.version, confirmed_by_user: true });
    }
    assert.ok(!first.isError, JSON.stringify(first.content));
    return first.structuredContent;
  }
  const orderOf = async (tenderId) => (await pool.query('SELECT * FROM orders WHERE id=$1', [Number(tenderId.slice(4))])).rows[0];

  try {
    // --- 5. Описания и синонимы: перенос из кода в базу, один раз ---------------------------------------------------------
    const before = (await harness.client(base)('GET', '/api/v1/categories?q=грузчики&lang=ru')).json;
    assert.ok(before.items.some((c) => c.id === 'movers'));
    assert.ok(await categories.migrateTexts() > 0);
    assert.equal(await categories.migrateTexts(), 0, 'only rows that were never migrated');
    const movers = await categories.get('movers');
    assert.ok(movers.synonyms.ru.includes('грузчик'), 'the old search words are kept');
    assert.ok(movers.synonyms.ru.includes('переезд'), 'group words stay with every service of the group');
    assert.ok(movers.descriptions.ru, 'the old description is kept');
    const moversSchema = (await call('GET', '/api/v1/categories?q=грузчики&lang=ru')).json.items.find((c) => c.id === 'movers');
    assert.equal(moversSchema.description, movers.descriptions.ru);
    assert.equal((await call('GET', '/api/v1/categories?q=грузчики&lang=ru')).json.catalog_version, before.catalog_version, 'migration alone changes nothing');

    // Единицы — только из справочника.
    await assert.rejects(categories.save(null, { name_ka: 'x', name_ru: 'Тест', name_en: 'Test', is_active: true, fields: [{ name_ru: 'Площадь', input: 'number', unit: 'кв.м', match: 'gte' }] }), /выберите из списка/);

    // --- 1. Клининг через админку ------------------------------------------------------------------------------------
    let response = await postForm('/admin/categories', {
      name_ru: 'Клининг', name_ka: 'დალაგება', name_en: 'Cleaning', icon: '🧽', sort_order: '60', kind: 'service', is_active: 'on', version: '1',
      'fields[0][name_ru]': 'Уборка после ремонта', 'fields[0][input]': 'bool', 'fields[0][match]': 'flag',
      'fields[1][name_ru]': 'Площадь за день', 'fields[1][input]': 'number', 'fields[1][unit]': 'm2', 'fields[1][min]': '10', 'fields[1][max]': '5000', 'fields[1][match]': 'gte',
      description_ru: 'Уборка квартир, домов и офисов: обычная, генеральная, после ремонта.', description_ka: 'ბინების, სახლებისა და ოფისების დალაგება.', description_en: 'Cleaning of flats, houses and offices: regular, deep, after renovation.',
      synonyms_ru: 'уборка, клининг, генеральная уборка', synonyms_ka: 'დალაგება, დასუფთავება', synonyms_en: 'cleaning, house cleaning', synonyms_latin: 'dalageba, dasuftaveba',
    });
    assert.equal(response.status, 302, await response.text());
    const slug = response.headers.get('location').split('/').pop();
    let cleaning = await categories.get(slug);
    const renovationKey = cleaning.fields.find((f) => f.input === 'bool').key;
    const areaKey = cleaning.fields.find((f) => f.input === 'number').key;
    assert.equal(cleaning.fields.find((f) => f.key === areaKey).unit, 'm2');
    // Параметры заявки (что спросить у заказчика) — второй правкой: они ссылаются на ключи характеристик.
    const editCleaning = (extra) => postForm('/admin/categories/' + slug, {
      name_ru: 'Клининг', name_ka: 'დალაგება', name_en: 'Cleaning', icon: '🧽', sort_order: '60', kind: 'service', is_active: 'on', version: String(cleaning.version),
      'fields[0][key]': renovationKey, 'fields[0][name_ru]': 'Уборка после ремонта', 'fields[0][input]': 'bool', 'fields[0][match]': 'flag',
      'fields[1][key]': areaKey, 'fields[1][name_ru]': 'Площадь за день', 'fields[1][input]': 'number', 'fields[1][unit]': 'm2', 'fields[1][min]': '10', 'fields[1][max]': '5000', 'fields[1][match]': 'gte',
      description_ru: cleaning.descriptions.ru, description_ka: cleaning.descriptions.ka, description_en: cleaning.descriptions.en,
      synonyms_ru: cleaning.synonyms.ru.join(', '), synonyms_ka: cleaning.synonyms.ka.join(', '), synonyms_en: cleaning.synonyms.en.join(', '), synonyms_latin: cleaning.synonyms.latin.join(', '),
      ...extra,
    });
    // Как настоящая форма: существующие параметры приходят со своими ключами (скрытые поля), новые — без ключа.
    const keyOf = (i) => (cleaning.request_fields?.[i]?.key ? { [`request_fields[${i}][key]`]: cleaning.request_fields[i].key } : {});
    const requestFieldsForm = (areaMax, options) => ({
      request_fields_touched: '1', ...keyOf(0), ...keyOf(1), ...keyOf(2),
      'request_fields[0][name_ru]': 'Площадь, м²', 'request_fields[0][input]': 'number', 'request_fields[0][unit]': 'm2', 'request_fields[0][min]': '5', 'request_fields[0][max]': String(areaMax),
      'request_fields[0][required]': 'on', 'request_fields[0][maps_field]': areaKey, 'request_fields[0][maps_rule]': 'provider_gte',
      'request_fields[1][name_ru]': 'Тип помещения', 'request_fields[1][input]': 'enum',
      ...Object.fromEntries(options.flatMap((o, i) => [[`request_fields[1][options][${i}][name_ru]`, o.name], ...(o.value ? [[`request_fields[1][options][${i}][value]`, o.value]] : [])])),
      'request_fields[2][name_ru]': 'После ремонта', 'request_fields[2][input]': 'bool', 'request_fields[2][maps_field]': renovationKey, 'request_fields[2][maps_rule]': 'provider_flag',
    });
    response = await editCleaning(requestFieldsForm(1000, [{ name: 'Квартира' }, { name: 'Офис' }]));
    assert.equal(response.status, 302, await response.text());
    cleaning = await categories.get(slug);
    const [areaParam, typeParam, renovationParam] = cleaning.request_fields;
    assert.deepEqual([areaParam.unit, areaParam.maps_to, renovationParam.maps_to], ['m2', { field: areaKey, rule: 'provider_gte' }, { field: renovationKey, rule: 'provider_flag' }]);

    // Исполнители клининга в Тбилиси: подходит только A (после ремонта и площадь от 120); у C площадь неизвестна.
    const cleanA = await harness.addMaster({ phone: '+995599700001', service: slug, attributes: { [renovationKey]: true, [areaKey]: 200 }, name: 'Clean A' });
    const cleanB = await harness.addMaster({ phone: '+995599700002', service: slug, attributes: { [renovationKey]: false, [areaKey]: 300 }, name: 'Clean B' });
    const cleanC = await harness.addMaster({ phone: '+995599700003', service: slug, attributes: { [renovationKey]: true }, name: 'Clean C' });

    // ChatGPT: поиск по синонимам на трёх языках и латиницей — без правки плагина.
    const anonymous = await connect();
    for (const [q, lang] of [['нужна генеральная уборка квартиры после ремонта', 'ru'], ['დალაგება ბინაში', 'ka'], ['house cleaning after renovation', 'en'], ['dalageba', 'ka']]) {
      const found = await ok(anonymous, 'search_categories', { q, lang, location_id: 'city:tbilisi' });
      assert.ok(found.items.some((c) => c.id === slug), `${q}: ${JSON.stringify(found.items.map((c) => c.id))}`);
    }
    const schema = await ok(anonymous, 'get_category_schema', { category_id: slug, lang: 'ru' });
    assert.deepEqual(schema.required_for_publish, [areaParam.key]);
    assert.equal(schema.json_schema.properties[areaParam.key]['x-xtender-unit'], 'm2');
    await anonymous.close();

    // Синонимы — данные админки: правка меняет версию каталога и выдачу поиска.
    const versionBefore = (await call('GET', '/api/v1/categories?q=химчистка&lang=ru')).json;
    assert.ok(!versionBefore.items.some((c) => c.id === slug));
    response = await editCleaning({ ...requestFieldsForm(1000, [{ name: 'Квартира', value: typeParam.options[0] }, { name: 'Офис', value: typeParam.options[1] }]), synonyms_ru: cleaning.synonyms.ru.join(', ') + ', химчистка мебели' });
    assert.equal(response.status, 302, await response.text());
    cleaning = await categories.get(slug);
    const versionAfter = (await call('GET', '/api/v1/categories?q=химчистка&lang=ru')).json;
    assert.notEqual(versionAfter.catalog_version, versionBefore.catalog_version, 'synonyms change the catalog version');
    assert.ok(versionAfter.items.some((c) => c.id === slug), 'the new word is found');

    // Заказчик в ChatGPT: черновик → проверка с оценкой → публикация. Модератор рассылает подготовленное.
    const customer = await connect((await harness.login(base, '+995599710001', SCOPES)).access_token);
    const start = new Date(Date.now() + 3 * day).toISOString();
    const draft = await ok(customer, 'create_tender_draft', { title: 'Уборка после ремонта', description: 'Квартира 120 м², пыль после ремонта', language: 'ru', category_ids: [slug],
      location: { city_id: 'city:tbilisi' }, requested_start_at: start, attributes: { [slug]: { [areaParam.key]: 120, [typeParam.key]: typeParam.options[0], [renovationParam.key]: true } } });
    const validation = await ok(customer, 'validate_tender', { tender_id: draft.id });
    assert.equal(validation.ready_to_publish, true, JSON.stringify(validation.fixes));
    assert.deepEqual([validation.supply_estimate.matching_providers, validation.supply_estimate.by_category[slug]], [1, 1], 'only A fits');
    await publishWithConsent(customer, draft);
    const cleanOrder = await orderOf(draft.id);
    assert.equal(cleanOrder.requirements.prepared.source, 'request');
    assert.deepEqual(cleanOrder.requirements.services[slug], { [renovationKey]: true, [areaKey]: 120 }, 'requirements come from the customer parameters');
    const cleanPlan = await dispatch.preview(cleanOrder.token, slug, '');
    assert.deepEqual(cleanPlan.recipients.map((m) => m.id), [cleanA.id], 'the moderator sees the same providers as the estimate');
    await dispatch.dispatch(cleanOrder.token, slug, '', { price: cleanPlan.price, count: cleanPlan.count, revision: 0 });
    assert.deepEqual(await accessOf(cleanOrder.id), [cleanA.id], 'B (no renovation) and C (unknown area) get nothing');
    assert.ok(![cleanB.id, cleanC.id].some((id) => cleanPlan.recipients.some((m) => m.id === id)));
    // Исполнитель A — предложение через ChatGPT.
    const providerA = await connect((await harness.login(base, cleanA.phone, SCOPES)).access_token);
    const offerDraft = await ok(providerA, 'create_offer_draft', { tender_id: draft.id, line_items: [{ offered_name: 'Уборка после ремонта, 120 м²', line_total_minor: 36000 }], start_at: start });
    const offer = await ok(providerA, 'submit_offer', { offer_id: offerDraft.id, version: offerDraft.version, confirmed_by_user: true });
    assert.equal(offer.status, 'submitted');
    assert.equal((await ok(customer, 'get_comparison_data', { tender_id: draft.id })).offers[0].offer.total_amount_minor, 36000);
    await providerA.close();

    // --- 4. Схема изменилась после сохранения черновика ----------------------------------------------------------------
    const staleDraft = await ok(customer, 'create_tender_draft', { title: 'Уборка офиса', description: 'Офис 900 м²', language: 'ru', category_ids: [slug], location: { city_id: 'city:tbilisi' },
      requested_start_at: start, attributes: { [slug]: { [areaParam.key]: 900, [typeParam.key]: typeParam.options[1] } } });
    const fineDraft = await ok(customer, 'create_tender_draft', { title: 'Уборка квартиры', description: 'Квартира 80 м²', language: 'ru', category_ids: [slug], location: { city_id: 'city:tbilisi' },
      requested_start_at: start, attributes: { [slug]: { [areaParam.key]: 80, [typeParam.key]: typeParam.options[0] } } });
    // Администратор сузил площадь до 500 и заменил вариант «Офис» на «Дом».
    response = await editCleaning(requestFieldsForm(500, [{ name: 'Квартира', value: typeParam.options[0] }, { name: 'Дом' }]));
    assert.equal(response.status, 302, await response.text());
    const conflict = await customer.callTool({ name: 'publish_tender', arguments: { tender_id: staleDraft.id, version: staleDraft.version, confirmed_by_user: true } });
    assert.equal(conflict.structuredContent.error.code, 'CATEGORY_SCHEMA_CHANGED');
    assert.deepEqual(conflict.structuredContent.error.schema_changes.map((c) => c.category_id), [slug]);
    const fixes = conflict.structuredContent.error.fixes;
    const areaFix = fixes.find((f) => f.path === `attributes.${slug}.${areaParam.key}`);
    const typeFix = fixes.find((f) => f.path === `attributes.${slug}.${typeParam.key}`);
    assert.deepEqual([areaFix.code, areaFix.max, typeFix.code], ['OUT_OF_RANGE', 500, 'INVALID_OPTION']);
    assert.ok(typeFix.allowed.includes(typeParam.options[0]) && !typeFix.allowed.includes(typeParam.options[1]) && typeFix.allowed.length === 2);
    assert.match(areaFix.message, /to 500/);
    assert.equal((await orderOf(staleDraft.id)).status, 'unverified', 'stale data is not published and not fixed silently');
    assert.equal((await orderOf(staleDraft.id)).request_attributes[slug][areaParam.key], 900);
    // Черновик, которому новая схема не мешает, публикуется.
    assert.equal((await ok(customer, 'publish_tender', { tender_id: fineDraft.id, version: fineDraft.version, confirmed_by_user: true })).publication_status, 'in_review');
    // Исправленный черновик проходит.
    const fixed = await ok(customer, 'update_tender_draft', { tender_id: staleDraft.id, version: staleDraft.version, attributes: { [slug]: { [areaParam.key]: 450, [typeParam.key]: typeParam.options[0] } } });
    assert.equal((await ok(customer, 'publish_tender', { tender_id: staleDraft.id, version: fixed.version, confirmed_by_user: true })).publication_status, 'in_review');
    // Выключенная категория — тоже понятный отказ.
    const offDraft = await ok(customer, 'create_tender_draft', { title: 'Ещё уборка', language: 'ru', category_ids: [slug], location: { city_id: 'city:tbilisi' }, requested_start_at: start,
      attributes: { [slug]: { [areaParam.key]: 60 } } });
    cleaning = await categories.get(slug);
    await categories.save(slug, { name_ka: 'დალაგება', name_ru: 'Клининг', name_en: 'Cleaning', version: cleaning.version, is_active: false, fields: cleaning.fields.map((f) => ({ ...f, name_ru: f.labels.ru })) });
    const inactive = await customer.callTool({ name: 'publish_tender', arguments: { tender_id: offDraft.id, version: offDraft.version, confirmed_by_user: true } });
    assert.ok(['CATEGORY_SCHEMA_CHANGED', 'NOT_READY'].includes(inactive.structuredContent.error.code));
    assert.ok(inactive.structuredContent.error.fixes.some((f) => f.code === 'CATEGORY_INACTIVE'));

    // --- 2. Перевозка 18 тонн ------------------------------------------------------------------------------------------
    const van20 = await harness.addMaster({ phone: '+995599720001', service: 'van', attributes: { size: 'L', body: 'closed', payload_t: 20 }, name: 'Truck 20t' });
    const van10 = await harness.addMaster({ phone: '+995599720002', service: 'van', attributes: { size: 'XXL', body: 'closed', payload_t: 10 }, name: 'Truck 10t XXL' });
    const vanUnknown = await harness.addMaster({ phone: '+995599720003', service: 'van', attributes: { size: 'XXL', body: 'closed' }, name: 'Truck unknown' });
    const vanTwo = await harness.addMaster({ phone: '+995599720004', service: 'van', attributes: { size: 'M', body: 'closed' }, name: 'Two trucks' });
    // Две машины этого исполнителя — через ту же функцию, что форма администратора: у каждой своя грузоподъёмность.
    await require('../src/services/master.service').updateMasterProfile(vanTwo.id, { name: 'Two trucks', phone: vanTwo.phone, services: [{ type: 'van', attributes: {
      cargo_length_cm: '300', cargo_width_cm: '160', cargo_height_cm: '160', body: 'closed', payload_t: '5',
      more_1_cargo_length_cm: '600', more_1_cargo_width_cm: '240', more_1_cargo_height_cm: '250', more_1_body: 'closed', more_1_payload_t: '25' } }] });
    const twoAttrs = (await pool.query("SELECT attributes FROM master_services WHERE master_id=$1 AND service_type='van'", [vanTwo.id])).rows[0].attributes;
    assert.deepEqual([twoAttrs.payload_t, twoAttrs.more_vehicles[0].payload_t], [5, 25], 'payload is stored per vehicle');
    const vanSchema = (await call('GET', '/api/v1/categories/van/schema?lang=ru')).json;
    assert.deepEqual(vanSchema.json_schema.properties.cargo_weight_t['x-xtender-maps-to'], { field: 'payload_t', rule: 'provider_gte' });
    assert.equal(vanSchema.json_schema.properties.cargo_weight_t['x-xtender-unit'], 't');

    const heavy = await ok(customer, 'create_tender_draft', { title: 'Перевезти 18 тонн', description: 'Стройматериалы, 18 тонн, из Тбилиси в Рустави', language: 'ru', category_ids: ['van'],
      location: { city_id: 'city:tbilisi' }, requested_start_at: start, attributes: { van: { cargo_weight_t: 18 } } });
    const heavyCheck = await ok(customer, 'validate_tender', { tender_id: heavy.id });
    assert.equal(heavyCheck.supply_estimate.matching_providers, 2, JSON.stringify(heavyCheck.supply_estimate));
    await ok(customer, 'publish_tender', { tender_id: heavy.id, version: heavy.version, confirmed_by_user: true });
    const heavyOrder = await orderOf(heavy.id);
    assert.deepEqual(heavyOrder.target_categories, ['transport']);
    assert.equal(heavyOrder.requirements.services.transport.payload_t, 18);
    assert.deepEqual(heavyOrder.requirements.transport_sizes, [], 'the body class S–XXL is not used for weight');
    const heavyPlan = await dispatch.preview(heavyOrder.token, 'transport', '');
    assert.deepEqual(heavyPlan.recipients.map((m) => m.id).sort((a, b) => a - b), [van20.id, vanTwo.id].sort((a, b) => a - b));
    // Экран модератора (план с отметками) считает так же.
    const screenPlan = await dispatch.planNeeds(heavyOrder.token, require('../src/services/orderNeeds.service').storedInput(heavyOrder));
    assert.equal(screenPlan.total, 2);
    await dispatch.dispatch(heavyOrder.token, 'transport', '', { price: heavyPlan.price, count: heavyPlan.count, revision: 0 });
    const heavyAccess = await accessOf(heavyOrder.id);
    assert.deepEqual(heavyAccess, [van20.id, vanTwo.id].sort((a, b) => a - b), 'the 10 t truck and the truck with unknown payload get nothing');
    assert.ok(!heavyAccess.includes(van10.id) && !heavyAccess.includes(vanUnknown.id));

    // --- 3. Ручная правка требований модератором — в журнале ------------------------------------------------------------
    const second = await ok(customer, 'create_tender_draft', { title: 'Ещё 18 тонн', language: 'ru', category_ids: ['van'], location: { city_id: 'city:tbilisi' }, requested_start_at: start,
      attributes: { van: { cargo_weight_t: 18 } } });
    await ok(customer, 'publish_tender', { tender_id: second.id, version: second.version, confirmed_by_user: true });
    const secondOrder = await orderOf(second.id);
    const input = require('../src/services/orderNeeds.service').storedInput(secondOrder);
    input.needAttributes.transport.payload_t = '22';
    const result = await dispatch.sendNeeds(secondOrder.token, input, null, '', { actor: 'manager:7' });
    assert.equal(result.count, 1, 'only the 25 t truck fits 22 t');
    const events = await require('../src/services/requestMatching.service').events(secondOrder.id);
    assert.deepEqual(events.map((e) => [e.action, e.actor]), [['prepared', 'system:request'], ['changed', 'manager:7']]);
    assert.equal(events[1].before_value.requirements.services.transport.payload_t, 18);
    assert.equal(events[1].after_value.requirements.services.transport.payload_t, 22);
    // Без изменений — без записи.
    const unchanged = await ok(customer, 'create_tender_draft', { title: 'И ещё', language: 'ru', category_ids: ['van'], location: { city_id: 'city:tbilisi' }, requested_start_at: start, attributes: { van: { cargo_weight_t: 18 } } });
    await ok(customer, 'publish_tender', { tender_id: unchanged.id, version: unchanged.version, confirmed_by_user: true });
    const unchangedOrder = await orderOf(unchanged.id);
    await dispatch.sendNeeds(unchangedOrder.token, require('../src/services/orderNeeds.service').storedInput(unchangedOrder), null, '', { actor: 'admin' });
    assert.deepEqual((await require('../src/services/requestMatching.service').events(unchangedOrder.id)).map((e) => e.action), ['prepared']);
    await customer.close();

    // Правка синонимов в пустоту остаётся пустой: перенос из кода её не возвращает.
    const moversNow = await categories.get('movers');
    await categories.save('movers', { name_ka: moversNow.name_ka, name_ru: moversNow.name_ru, name_en: moversNow.name_en, version: moversNow.version, is_active: true,
      fields: moversNow.fields.map((f) => ({ ...f, name_ru: f.labels?.ru || f.key })), synonyms_ru: '', synonyms_ka: '', synonyms_en: '', synonyms_latin: '',
      description_ru: moversNow.descriptions.ru, description_ka: moversNow.descriptions.ka, description_en: moversNow.descriptions.en });
    assert.equal(await categories.migrateTexts(), 0);
    assert.deepEqual((await categories.get('movers')).synonyms.ru, []);
    process.stdout.write('catalog and matching tests passed\n');
  } finally {
    server.close();
    adminServer.close();
  }
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
