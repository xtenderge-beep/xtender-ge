// Каталог API v1 (ТЗ, раздел 16): /capabilities честно отличает сделанное от несделанного; поиск категорий по
// описанию потребности на ka/ru/en и латиницей; нерелевантный запрос не придумывает категорию; новая категория
// из админки находится без правки кода и меняет catalog_version; выключенная не предлагается, но её схема читается;
// схема — JSON Schema с правилами подбора и кодами единиц; наличие исполнителей по городу; полная пагинация
// и устаревший курсор; география и единицы.
const assert = require('node:assert/strict');
const harness = require('./api-v1-harness');

// Эталонные запросы (зафиксированы до сдачи, ТЗ 16, проверка 4): запрос → ожидаемые категории.
const REFERENCE = [
  ['спустить мешки с мусором со второго этажа', 'ru', ['movers', 'junk']],
  ['нужны 2 грузчика на переезд', 'ru', ['movers', 'van']],
  ['газель до Батуми', 'ru', ['van']],
  ['вывезти строительный мусор после ремонта', 'ru', ['junk']],
  ['перевезти пианино', 'ru', ['van', 'movers']],
  ['მუშები ავეჯის გადასატანად', 'ka', ['movers', 'van']],
  ['ევაკუატორი მჭირდება', 'ka', ['tow']],
  ['ავტოამწე ფასადისთვის', 'ka', ['bucket_lift']],
  ['mushebi saburtaloze', 'en', ['movers']],
  ['need a van to move a sofa', 'en', ['van', 'movers']],
  ['my car broke down, need towing', 'en', ['tow']],
];
// Нерелевантные: сервис не предлагает несуществующих категорий (ТЗ 16, проверка 5).
const IRRELEVANT = ['нотариус', 'ремонт ванной', '4 этаж без лифта', 'уборка квартиры', 'ნოტარიუსი', 'legal advice', 'xyz'];

(async () => {
  const { server, base } = await harness.start();
  const call = harness.client(base);
  const get = (url) => call('GET', url).then((r) => { assert.equal(r.status, 200, url + ' → ' + r.text); return r.json; });
  try {
    await harness.addMaster({ service: 'movers', attributes: { crew_size: 2 } });
    await harness.addMaster({ service: 'movers', attributes: { crew_size: 4 } });
    await harness.addMaster({ service: 'van', attributes: { size: 'L', body: 'closed' } });
    await harness.addMaster({ service: 'junk', attributes: { volume_m3: '4' }, active: false });

    // 1. Возможности без входа: сделанное supported, остальное нет; доступность неизвестна (null).
    let caps = await get('/api/v1/capabilities?lang=ru');
    assert.equal(caps.environment, 'sandbox');
    assert.match(caps.catalog_version, /^cat_[a-f0-9]{16}$/);
    assert.match(caps.service_description, /модератор Xtender проверяет/);
    assert.deepEqual(caps.coverage_summary.served_cities.map((c) => c.id), ['city:tbilisi']);
    const action = (id) => caps.actions.find((a) => a.id === id);
    assert.equal(action('search_categories').supported, true);
    for (const id of ['publish_tender', 'select_offer', 'submit_offer', 'send_message', 'subscribe_tender_notifications']) {
      assert.deepEqual([action(id).supported, action(id).available_to_user], [true, null], id);
    }
    for (const id of ['upload_attachment', 'create_project']) {
      assert.deepEqual([action(id).supported, action(id).unavailable_reason], [false, 'not_implemented'], id);
    }
    assert.equal(action('publish_tender').requires_confirmation, true);
    assert.ok(caps.actions.every((a) => a.available_to_user === null));
    const smsChannel = caps.notification_channels.find((c) => c.channel === 'sms');
    assert.deepEqual([smsChannel.supported, smsChannel.requires_consent], [true, true], 'SMS по заявкам — только с согласием');
    assert.equal(caps.deal.default_response_mode, 'offers');
    assert.equal(caps.constraints.attachments.supported, false);

    // 2. Эталонные запросы: найдены именно ожидаемые категории, с найденными словами.
    for (const [q, lang, expected] of REFERENCE) {
      const result = await get('/api/v1/categories?' + new URLSearchParams({ q, lang, location_id: 'city:tbilisi' }));
      assert.deepEqual(result.items.map((i) => i.id).sort(), [...expected].sort(), q);
      assert.equal(result.match_status, expected.length === 1 ? 'matched' : 'ambiguous', q);
      assert.ok(result.items.every((i) => i.matched_terms.length && i.match_rank >= 1), q);
    }
    for (const q of IRRELEVANT) {
      const result = await get('/api/v1/categories?' + new URLSearchParams({ q }));
      assert.deepEqual([result.items.length, result.match_status], [0, 'none'], q);
    }

    // 3. Карточка категории: имя на языке ответа, синонимы, неизвестный состав работ — null, а не пусто.
    let result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'грузчики', lang: 'ka', location_id: 'city:tbilisi' }));
    const movers = result.items[0];
    assert.deepEqual([movers.id, movers.name, movers.kind, movers.parent_id], ['movers', 'მუშები', 'service', null]);
    assert.ok(movers.synonyms.includes('მტვირთავი') && movers.synonyms.includes('mushebi'));
    assert.deepEqual([movers.included_services, movers.excluded_services], [null, null]);
    assert.deepEqual(movers.availability, { status: 'supported', reason: null, location_id: 'city:tbilisi' });
    assert.deepEqual([movers.supply_status.status, movers.supply_status.provider_count], ['providers_present', 2]);
    assert.ok(movers.supply_status.checked_at);
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'вывоз мусора', location_id: 'city:tbilisi' }));
    assert.deepEqual([result.items[0].id, result.items[0].supply_status.status], ['junk', 'none_known'], 'исполнитель на модерации не считается');
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'грузчики', location_id: 'city:batumi' }));
    assert.deepEqual(result.items[0].availability, { status: 'unsupported', reason: 'city_not_served', location_id: 'city:batumi' });
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'грузчики' }));
    assert.deepEqual([result.items[0].availability.status, result.items[0].supply_status.status], ['unknown', 'unknown'], 'без географии доступность не утверждаем');
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'грузчики', location_id: 'district:saburtalo' }));
    assert.equal(result.items[0].availability.status, 'supported', 'район — по своему городу');
    assert.equal((await get('/api/v1/categories?kind=goods')).items.length, 0, 'товаров в каталоге пока нет');

    // 4. Ошибки параметров.
    let r = await call('GET', '/api/v1/categories?' + new URLSearchParams({ q: 'x'.repeat(301) }));
    assert.deepEqual([r.status, r.json.error.fields[0]], [422, { path: 'q', code: 'TOO_LONG' }]);
    r = await call('GET', '/api/v1/categories?location_id=city:paris');
    assert.deepEqual([r.status, r.json.error.fields[0].code], [422, 'UNKNOWN_LOCATION']);
    r = await call('GET', '/api/v1/categories?lang=de');
    assert.equal(r.status, 422);
    r = await call('GET', '/api/v1/categories?limit=500');
    assert.equal(r.status, 422);
    assert.match(r.json.request_id, /^req_/);

    // 5. Схема категории — параметры заявки отдельно от характеристик исполнителя, с явным правилом подбора (уточнение 1):
    // «объём мусора, м³» заказчика сравнивается с «объёмом кузова» исполнителя; этаж — только для исполнителя.
    let schema = await get('/api/v1/categories/junk/schema?lang=en');
    assert.match(schema.schema_version, /^cs_[a-f0-9]{16}$/);
    assert.deepEqual([schema.kind, schema.required_for_publish, schema.item_rules.items_required], ['service', [], false]);
    const props = schema.json_schema.properties;
    assert.deepEqual(Object.keys(props).sort(), ['dump_body', 'floor', 'waste_volume_m3']);
    assert.deepEqual([props.waste_volume_m3.type, props.waste_volume_m3['x-xtender-unit'], props.waste_volume_m3['x-xtender-maps-to']],
      ['number', 'm3', { field: 'volume_m3', rule: 'provider_gte' }]);
    assert.equal(props.floor['x-xtender-maps-to'], undefined, 'этаж не участвует в подборе');
    assert.equal(props.dump_body.title, 'Dump truck needed');
    assert.match(props.dump_body.description, /never "no"/, 'отсутствие отметки — неизвестно, не false');
    assert.equal(schema.json_schema.additionalProperties, false);
    schema = await get('/api/v1/categories/van/schema?lang=ru');
    assert.equal(schema.json_schema.properties.with_helpers.title, 'Нужна машина с грузчиками', 'слова заказчика, не исполнителя');
    assert.equal(schema.json_schema.properties.cargo_size.oneOf.find((o) => o.const === 'M').title, 'M — кузов от 260×130×150 см (Д×Ш×В)');
    assert.deepEqual(schema.json_schema.properties.cargo_size['x-xtender-maps-to'], { field: 'size', rule: 'provider_gte' });
    schema = await get('/api/v1/categories/movers/schema?lang=en');
    assert.deepEqual([schema.json_schema.properties.workers.minimum, schema.json_schema.properties.workers['x-xtender-unit'],
      schema.json_schema.properties.workers['x-xtender-maps-to'].field], [1, 'person', 'crew_size']);
    assert.equal((await call('GET', '/api/v1/categories/notary/schema')).status, 404);

    // 6. Новая категория через админку (category.service.save) — без нового маршрута и правки кода.
    const categoryService = require('../src/services/category.service');
    const before = (await get('/api/v1/capabilities')).catalog_version;
    // Единица — только из справочника: «лет» в нём нет, редактор её не примет.
    await assert.rejects(categoryService.save(null, { name_ka: 'სანტექნიკი', name_ru: 'Сантехники', name_en: 'Plumbers', is_active: true,
      fields: [{ input: 'number', name_ru: 'Стаж', unit: 'лет', match: 'gte' }] }), /выберите из списка/);
    const created = await categoryService.save(null, { name_ka: 'სანტექნიკი', name_ru: 'Сантехники', name_en: 'Plumbers', icon: '🔧', sort_order: 50, is_active: true,
      fields: [{ input: 'number', name_ru: 'Стаж', name_en: 'Experience', unit: '', min: 1, max: 50, match: 'gte' }, { input: 'text', name_ru: 'Инструмент' }] });
    caps = await get('/api/v1/capabilities');
    assert.notEqual(caps.catalog_version, before, 'catalog_version сменилась');
    for (const [q, lang] of [['сантехник', 'ru'], ['სანტექნიკი', 'ka'], ['plumber', 'en'], ['santeqniki', 'en']]) {
      result = await get('/api/v1/categories?' + new URLSearchParams({ q, lang }));
      assert.deepEqual(result.items.map((i) => i.id), [created.slug], q);
    }
    schema = await get(`/api/v1/categories/${created.slug}/schema?lang=en`);
    const added = Object.values(schema.json_schema.properties);
    assert.equal(added.length, 1, 'текстовое поле без правила подбора — не параметр заявки');
    assert.deepEqual([added[0].title, added[0].type, added[0].minimum, added[0]['x-xtender-unit']], ['Experience', 'number', 1, undefined]);
    const firstSchemaVersion = schema.schema_version;
    const row = await categoryService.get(created.slug);
    await categoryService.save(created.slug, { name_ka: row.name_ka, name_ru: row.name_ru, name_en: row.name_en, icon: row.icon, sort_order: 50, is_active: true, version: row.version,
      fields: [...row.fields.map((f) => ({ key: f.key, input: f.input, name_ru: f.labels.ru, name_en: f.labels.en, unit: f.unit, min: f.min, max: f.max, match: f.match })),
        { input: 'bool', name_ru: 'Срочный выезд', name_en: 'Urgent call-out', match: 'flag' }] });
    schema = await get(`/api/v1/categories/${created.slug}/schema?lang=en`);
    assert.notEqual(schema.schema_version, firstSchemaVersion, 'правка полей меняет schema_version');
    assert.equal(Object.keys(schema.json_schema.properties).length, 2);
    // Свои параметры заявки из редактора: обязательный для публикации и связанный с характеристикой исполнителя.
    const withFlag = await categoryService.get(created.slug);
    const experienceKey = withFlag.fields.find((f) => f.labels.ru === 'Стаж').key;
    await categoryService.save(created.slug, { name_ka: withFlag.name_ka, name_ru: withFlag.name_ru, name_en: withFlag.name_en, icon: withFlag.icon, sort_order: 50, is_active: true, version: withFlag.version,
      fields: withFlag.fields.map((f) => ({ key: f.key, input: f.input, name_ru: f.labels.ru, name_en: f.labels.en, unit: f.unit, min: f.min, max: f.max, match: f.match })),
      request_fields: [
        { input: 'number', name_ru: 'Минимальный стаж мастера, лет', name_en: 'Minimum experience, years', min: 0, max: 50, required: true, maps_field: experienceKey, maps_rule: 'provider_gte' },
        { input: 'enum', name_ru: 'Что сломалось', name_en: 'What broke', options: [{ name_ru: 'Кран', name_en: 'Tap' }, { name_ru: 'Трубы', name_en: 'Pipes' }] },
      ] });
    schema = await get(`/api/v1/categories/${created.slug}/schema?lang=en`);
    const own = Object.entries(schema.json_schema.properties);
    assert.deepEqual(own.map(([, p]) => p.title), ['Minimum experience, years', 'What broke']);
    assert.deepEqual(own[0][1]['x-xtender-maps-to'], { field: experienceKey, rule: 'provider_gte' });
    assert.deepEqual(schema.required_for_publish, [own[0][0]]);
    await assert.rejects(categoryService.save(created.slug, { ...withFlag, version: (await categoryService.get(created.slug)).version,
      fields: withFlag.fields.map((f) => ({ key: f.key, input: f.input, name_ru: f.labels.ru, match: f.match })),
      request_fields: [{ input: 'text', name_ru: 'Описание', maps_field: experienceKey, maps_rule: 'provider_flag' }] }), { status: 400 }, 'правило не подходит к типам');
    // Категория товаров: позиции закупки обязательны, поиск по виду.
    const goods = await categoryService.save(null, { name_ka: 'სამშენებლო მასალები', name_ru: 'Стройматериалы', name_en: 'Building materials', kind: 'goods', is_active: true, sort_order: 70, fields: [] });
    schema = await get(`/api/v1/categories/${goods.slug}/schema?lang=ru`);
    assert.deepEqual([schema.kind, schema.required_for_publish, schema.item_rules.items_required], ['goods', ['items'], true]);
    assert.deepEqual((await get('/api/v1/categories?kind=goods')).items.map((i) => [i.id, i.kind]), [[goods.slug, 'goods']]);
    assert.ok((await get('/api/v1/categories?q=стройматериалы')).items.some((i) => i.id === goods.slug));

    // 7. Выключенная категория: не предлагается, но читается (исторические заявки), с active_only=false — с причиной.
    const current = await categoryService.get(created.slug);
    await categoryService.save(created.slug, { name_ka: current.name_ka, name_ru: current.name_ru, name_en: current.name_en, icon: current.icon, sort_order: 50, is_active: false, version: current.version,
      fields: current.fields.map((f) => ({ key: f.key, input: f.input, name_ru: f.labels.ru, name_en: f.labels.en, unit: f.unit, min: f.min, max: f.max, match: f.match })) });
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'сантехник' }));
    assert.equal(result.match_status, 'none');
    result = await get('/api/v1/categories?' + new URLSearchParams({ q: 'сантехник', active_only: 'false', location_id: 'city:tbilisi' }));
    assert.deepEqual([result.items[0].active, result.items[0].availability.reason], [false, 'category_inactive']);
    schema = await get(`/api/v1/categories/${created.slug}/schema`);
    assert.equal(schema.active, false);

    // 8. Пагинация: страницы читаются полностью; курсор от другого запроса и устаревший курсор отклоняются.
    const seen = [];
    let url = '/api/v1/categories?limit=2&active_only=false';
    let page;
    do {
      page = await get(url);
      seen.push(...page.items.map((i) => i.id));
      url = '/api/v1/categories?limit=2&active_only=false&cursor=' + page.next_cursor;
    } while (page.has_more);
    assert.equal(seen.length, page.total);
    assert.equal(new Set(seen).size, seen.length, 'без повторов');
    const firstPage = await get('/api/v1/categories?limit=2');
    r = await call('GET', '/api/v1/categories?limit=2&q=грузчики&cursor=' + firstPage.next_cursor);
    assert.deepEqual([r.status, r.json.error.code], [400, 'INVALID_CURSOR']);
    await categoryService.save(null, { name_ka: 'ახალი', name_ru: 'Новая услуга', name_en: 'New service', is_active: true, sort_order: 60, fields: [] });
    r = await call('GET', '/api/v1/categories?limit=2&cursor=' + firstPage.next_cursor);
    assert.deepEqual([r.status, r.json.error.code], [409, 'SNAPSHOT_CHANGED'], 'устаревший снимок выявлен');

    // 9. География и единицы.
    let locations = await get('/api/v1/locations?lang=en');
    assert.deepEqual(locations.items.slice(0, 2).map((l) => [l.id, l.served]), [['country:GE', true], ['city:tbilisi', true]]);
    assert.equal(locations.items.find((l) => l.id === 'city:batumi').served, false);
    locations = await get('/api/v1/locations?parent_id=city:tbilisi&limit=100');
    assert.equal(locations.items.length, 10);
    for (const q of ['Saburtalo', 'საბურთალო', 'Сабуртало', 'saburt']) {
      locations = await get('/api/v1/locations?' + new URLSearchParams({ q, lang: 'ka' }));
      assert.deepEqual(locations.items.map((l) => l.id), ['district:saburtalo'], q);
      assert.equal(locations.items[0].name, 'საბურთალო');
    }
    const unitList = await get('/api/v1/units?lang=ka');
    assert.ok(unitList.items.some((u) => u.code === 'm3' && u.short === 'მ³'));
    const units = require('../src/config/units');
    assert.deepEqual(['м³', 'чел.', 'см', 'т', 'лет'].map(units.codeFor), ['m3', 'person', 'cm', 't', null]);
    r = await call('GET', '/api/v1/units');
    assert.match(r.headers.get('cache-control'), /public/, 'справочник без входа кешируется');
    assert.equal((await call('GET', '/api/v1/nothing-here')).json.error.code, 'NOT_FOUND');
  } finally {
    server.close();
  }
  process.stdout.write('api v1 catalog tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
