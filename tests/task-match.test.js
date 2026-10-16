// Подбор по смыслу на главной (taskMatch.service): в модель уходит текст без номеров телефонов и список услуг
// с их полями; из ответа остаются только известные услуги, поля, значения и особенности; один текст в модель
// второй раз не идёт; запросы с одного адреса ограничены; сбой модели — null, страница на словаре.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const stub = (p, exports) => { require.cache[require.resolve(p)] = { exports }; };
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool);
stub('../src/config/redis', redis);
const taskMatch = require('../src/services/taskMatch.service');

(async () => {
  const prompts = [];
  let answer = JSON.stringify({
    services: [
      { key: 'movers', main: true, attributes: { crew_size: 2, color: 'red' } },
      { key: 'van', main: false, attributes: { size: 'HUGE', body: 'closed', tail_lift: 'yes' } },
      { key: 'rockets', main: true },
      'movers',
    ],
    features: ['piano', 'unknown'],
  });
  taskMatch.useModel(async (prompt) => { prompts.push(prompt); return 'Sure! ' + answer; });

  const text = 'Переезд завтра, нужны 2 грузчика и пианино. Звоните +995 599 12 34 56';
  const result = await taskMatch.match({ text, ip: '10.0.0.1' });
  assert.deepEqual(result, {
    services: [{ key: 'movers', main: true, attributes: { crew_size: 2 } }, { key: 'van', main: false, attributes: { body: 'closed' } }],
    features: ['piano'],
  });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes('599 12 34 56') && prompts[0].includes('Звоните •••'), 'phone numbers are hidden from the model');
  assert.ok(prompts[0].includes('- movers = ') && prompts[0].includes('crew_size: number'), 'services with their fields');
  assert.ok(prompts[0].includes('size: vehicle body class, ONLY if the cargo dimensions are stated'), 'van size classes');
  assert.ok(prompts[0].includes('piano = пианино'), 'features');

  // Тот же текст (с другими пробелами и регистром) второй раз в модель не идёт.
  assert.deepEqual(await taskMatch.match({ text: '  ' + text.toUpperCase() + ' ', ip: '10.0.0.1' }), result);
  assert.equal(prompts.length, 1, 'cached');

  // Короткий текст — без модели.
  assert.equal(await taskMatch.match({ text: 'груз', ip: '10.0.0.1' }), null);

  // Значения вне пределов поля отбрасываются; непонятный ответ — null и не кешируется.
  answer = JSON.stringify({ services: [{ key: 'movers', attributes: { crew_size: 50 } }], features: [] });
  assert.deepEqual(await taskMatch.match({ text: 'Нужна бригада грузчиков на склад', ip: '10.0.0.2' }), { services: [{ key: 'movers', main: true, attributes: {} }], features: [] });
  answer = 'no json here';
  assert.equal(await taskMatch.match({ text: 'Что-то совсем непонятное', ip: '10.0.0.2' }), null);
  answer = JSON.stringify({ services: [], features: [] });
  assert.deepEqual(await taskMatch.match({ text: 'Что-то совсем непонятное', ip: '10.0.0.2' }), { services: [], features: [] }, 'a failed answer was not cached');

  // Сбой модели не бросает.
  taskMatch.useModel(async () => { throw new Error('timeout'); });
  const quiet = console.error;
  console.error = () => {};
  assert.equal(await taskMatch.match({ text: 'Нужен эвакуатор на Сабуртало', ip: '10.0.0.3' }), null);
  console.error = quiet;

  // Лимит запросов с одного адреса; повтор из кеша лимит не тратит.
  taskMatch.useModel(async () => JSON.stringify({ services: [{ key: 'tow', main: true }], features: [] }));
  for (let i = 0; i < taskMatch.RATE_LIMIT_MAX; i++) assert.ok(await taskMatch.match({ text: 'Нужен эвакуатор номер ' + i, ip: '10.0.0.9' }), 'request ' + i);
  assert.equal(await taskMatch.match({ text: 'Нужен эвакуатор ещё один', ip: '10.0.0.9' }), null, 'over the limit');
  assert.ok(await taskMatch.match({ text: 'Нужен эвакуатор номер 1', ip: '10.0.0.9' }), 'cached text still answers');
  assert.ok(await taskMatch.match({ text: 'Нужен эвакуатор ещё один', ip: '10.0.0.10' }), 'another address is not limited');

  // ---- Полный подбор: кандидаты из каталога города и порядок по смыслу ----
  const tbilisi = (await pool.query("SELECT id FROM cities WHERE slug = 'tbilisi'")).rows[0].id;
  const addProvider = async (name, phone, service, attributes, description) => {
    const id = (await pool.query('INSERT INTO masters (name, phone, is_active, city_id, description) VALUES ($1, $2, true, $3, $4) RETURNING id', [name, phone, tbilisi, description])).rows[0].id;
    await pool.query('INSERT INTO master_services (master_id, service_type, attributes, is_primary) VALUES ($1, $2, $3::jsonb, true)', [id, service, JSON.stringify(attributes)]);
    return id;
  };
  const solo = await addProvider('Bachana', '+995500000101', 'movers', { crew_size: 1 }, 'Работаю один.');
  const crew = await addProvider('Davit', '+995500000102', 'movers', { crew_size: 3 }, 'Переезды, перевозим пианино. Звоните 599 11 22 33');
  const van = await addProvider('Levan', '+995500000103', 'van', { size: 'M', body: 'closed' }, 'Газель, перевозка мебели.');
  await addProvider('Gela', '+995500000104', 'tow', { tow_type: 'platform', max_tonnage: '3.5' }, 'Эвакуатор.');
  const unknownCrew = await addProvider('Nika', '+995500000105', 'movers', {}, 'Погрузка и разгрузка.');

  const rankPrompts = [];
  let rerankAnswer = () => JSON.stringify({ providers: [van, crew, 999, crew] });
  taskMatch.useModel(async (prompt) => {
    if (prompt.includes('Order them by how well')) { rankPrompts.push(prompt); return rerankAnswer(); }
    return JSON.stringify({ services: [{ key: 'movers', main: true, attributes: { crew_size: 2 } }, { key: 'van', main: false }], features: ['piano'] });
  });
  const task = 'Завтра переезд, нужны 2 грузчика и перевезти пианино';
  const ranked = await taskMatch.rank({ text: task, ip: '10.0.1.1', locale: 'ru', citySlug: 'tbilisi' });
  assert.deepEqual(ranked.providers, [van, crew], 'the model order, only listed candidates');
  assert.deepEqual(ranked.services.map((s) => s.key), ['movers', 'van']);
  const sent = rankPrompts[0];
  assert.ok(sent.includes(`#${crew} | Грузчики (3 чел.) | #грузчики #пианино`), 'crew, tags and description of a candidate');
  assert.ok(!sent.includes(`#${solo} `), 'a crew of one does not fit «2 movers»');
  assert.ok(!sent.includes('Эвакуатор'), 'other services are not candidates');
  assert.ok(sent.includes(`#${unknownCrew} `), 'unknown crew size stays a candidate');
  assert.ok(!/Bachana|Davit|Levan|Nika|\+9955/.test(sent) && !sent.includes('599 11 22 33'), 'no names or phones go to the model');
  assert.ok(sent.indexOf(`#${crew} `) < sent.indexOf(`#${unknownCrew} `) && sent.indexOf(`#${unknownCrew} `) < sent.indexOf(`#${van} `), 'candidates in the base order');

  // Тот же текст и те же кандидаты — без второго обращения к модели.
  await taskMatch.rank({ text: task, ip: '10.0.1.1', locale: 'ru', citySlug: 'tbilisi' });
  assert.equal(rankPrompts.length, 1, 'ranking cached');

  // Модель упорядочить не смогла — остаётся порядок по услугам, характеристикам и особенностям.
  rerankAnswer = () => { throw new Error('timeout'); };
  console.error = () => {};
  const fallback = await taskMatch.rank({ text: 'Послезавтра переезд, нужны 2 грузчика и пианино', ip: '10.0.1.1', locale: 'ru', citySlug: 'tbilisi' });
  console.error = quiet;
  assert.deepEqual(fallback.providers, [crew, unknownCrew, van]);

  // Суточный потолок обращений к модели: сверх него — null (страница на словаре), кеш по-прежнему отвечает.
  await redis.set('task_match_day:' + new Date().toISOString().slice(0, 10), String(taskMatch.DAILY_MODEL_CALLS));
  assert.equal(await taskMatch.match({ text: 'Нужна автовышка на 20 метров', ip: '10.0.2.1' }), null, 'over the daily cap');
  assert.ok(await taskMatch.match({ text: 'Нужен эвакуатор номер 1', ip: '10.0.2.1' }), 'cached answers still work');

  console.log('PASS: task match — daily cap on model calls, phones hidden from the model, services and fields in the prompt, only known services, fields, values and features kept, cache, short text, failures, rate limit per address; ranking: catalog candidates by service and characteristics without names or phones, model order limited to candidates, cached, base order when the model fails.');
})().catch((error) => { console.error(error); process.exit(1); });
