const axios = require('axios');
const crypto = require('crypto');

// Подбор по смыслу на главной: ИИ читает задачу, которую человек пишет, и отвечает, какие услуги нужны
// (main — то, что просят прямо; иначе то, что такой задаче обычно тоже нужно, например машина при переезде),
// какие требования к характеристикам исполнителя (бригада, тоннаж, объём, высота — поля услуги из админки) и
// какие особенности (#пианино). С исполнителями сравнивает сама страница. Правила:
//  - ответу модели не доверяем: только известные услуги, поля, значения и особенности;
//  - номера телефонов прячутся до отправки текста;
//  - один и тот же текст второй раз в модель не идёт (Redis, сутки), запросы с одного адреса ограничены;
//  - без OPENROUTER_API_KEY, при сбое или лимите — null: страница остаётся на подборе по словарю.
// Тот же OpenRouter, что у перевода заявок и карточки «Кратко».
const MODEL = process.env.OPENROUTER_MATCH_MODEL || process.env.OPENROUTER_TRANSLATION_MODEL || 'google/gemini-2.5-flash-lite';
const KEY = process.env.OPENROUTER_API_KEY;
const CALL_TIMEOUT_MS = 8000;
// Меняется вместе с текстом подсказок: ответы прежней версии из кеша не берутся.
const PROMPT_VERSION = 3;
const MIN_LENGTH = 8;
const MAX_LENGTH = 1000;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
// Адрес /api/task-match открыт: кроме лимита на адрес — общий потолок обращений к модели за сутки (по UTC).
const DAILY_MODEL_CALLS = Number(process.env.TASK_MATCH_DAILY_LIMIT) || 3000;

// true — обращение к модели в пределах суточного потолка (и засчитано).
async function withinDailyLimit(redis) {
  const key = 'task_match_day:' + new Date().toISOString().slice(0, 10);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2 * 24 * 60 * 60);
  return count <= DAILY_MODEL_CALLS;
}

// Тесты и локальная проверка подставляют свою модель вместо обращения к OpenRouter.
let model = null;
const useModel = (fn) => { model = fn; };
const enabled = () => Boolean(model || KEY);

// Поле услуги в подсказке: что модель может вернуть. Текстовые поля и поля без сравнения не нужны.
function describeField(field, sizes) {
  if (field.input === 'number') {
    const range = [field.min, field.max].every((v) => v !== null && v !== undefined) ? `, ${field.min}-${field.max}` : '';
    return `${field.key}: number${field.unit ? ' (' + field.unit + ')' : ''}${range} — ${field.label}`;
  }
  if (field.input === 'bool') return `${field.key}: true only if required — ${field.label}`;
  if (field.input === 'size') {
    return `${field.key}: vehicle body class, ONLY if the cargo dimensions are stated: ` +
      sizes.map((s) => `${s.code} = body from ${s.length}x${s.width}x${s.height} cm`).join('; ');
  }
  return `${field.key}: one of ${field.options.map((o) => `${o.value} (${o.label})`).join(', ')} — ${field.label}`;
}

function buildPrompt({ text, services, features, sizes }) {
  const serviceLines = services.map((s) => {
    const fields = s.fields.filter((f) => f.match !== 'ignore' && f.input !== 'text').map((f) => '    ' + describeField(f, sizes));
    return `- ${s.type} = ${s.label}${fields.length ? '\n' + fields.join('\n') : ''}`;
  }).join('\n');
  return `A customer on a Tbilisi marketplace of movers, vans, tow trucks, bucket lifts, waste removal and other local services is typing a task. Decide which providers can do it.

Return ONE JSON object and nothing else:
{"services": [{"key": "<service key>", "main": true, "attributes": {"<field>": <value>}}], "features": ["<feature key>"]}

services - keys from the list below, the most important first, at most 4:
  "main": true - what the customer asks for directly;
  "main": false - what such a task usually also needs even if it is not named (a home or office move usually needs movers AND a van; removing construction waste usually needs loaders).
  [] if the task does not say what is needed.
attributes - put them INSIDE each service object. Only requirements the task states, using the field keys listed for that service and their allowed values: a number of people -> the crew field ("2 movers", "нужны 2 грузчика", "ორი მუშა" -> 2), tonnage, volume, height, body type. Numbers as numbers. Leave out anything not stated.

Example. Task: "на завтра нужен переезд, нужны 2 грузчика, 3 этаж"
{"services": [{"key": "movers", "main": true, "attributes": {"crew_size": 2}}, {"key": "van", "main": false, "attributes": {}}], "features": []}
Example. Task: "evakuatori mchirdeba vakeshi"
{"services": [{"key": "tow", "main": true, "attributes": {}}], "features": []}
features - keys from the feature list that the task mentions, [] if none.
Use only what the text says; never guess. The text may be in Georgian, Russian or English, Georgian also in Latin letters, with typos.

Services:
${serviceLines}

Features: ${features.map((f) => `${f.key} = ${f.label}`).join('; ')}

Task:
${text}`;
}

async function callModel(prompt) {
  // Запас по длине обязателен: с max_tokens 400 модель на проде отвечала пустым разбором (2026-10-16), с 1500
  // она же верно разобрала все 9 проверочных задач на трёх языках.
  const body = { model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 1500 };
  const send = (extra) => axios.post('https://openrouter.ai/api/v1/chat/completions', { ...body, ...extra },
    { headers: { Authorization: `Bearer ${KEY}`, 'HTTP-Referer': 'https://xtender.ge', 'X-Title': 'xtender.ge' }, timeout: CALL_TIMEOUT_MS });
  let res;
  try { res = await send({ response_format: { type: 'json_object' } }); }
  catch (error) {
    // Модель или провайдер могут не принимать response_format — тогда JSON только по словам подсказки.
    if (error.response?.status !== 400) throw error;
    res = await send({});
  }
  return res.data.choices?.[0]?.message?.content || '';
}

// Ответ модели — только известные услуги, поля, значения в допустимых пределах и известные особенности.
function sanitize(raw, services, featureKeys) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const byKey = new Map(services.map((s) => [s.type, s]));
  const result = [];
  for (const item of Array.isArray(data.services) ? data.services : []) {
    const key = typeof item === 'string' ? item : item && item.key;
    const service = byKey.get(key);
    if (!service || result.some((s) => s.key === key)) continue;
    const asked = item && typeof item.attributes === 'object' && item.attributes ? item.attributes : {};
    const attributes = {};
    for (const field of service.fields) {
      const value = asked[field.key];
      if (value === undefined || value === null || value === '') continue;
      if (field.input === 'number') {
        const number = Number(value);
        if (Number.isFinite(number) && (field.min == null || number >= field.min) && (field.max == null || number <= field.max)) attributes[field.key] = number;
      } else if (field.input === 'enum' || field.input === 'size') {
        if (field.options.some((o) => o.value === String(value))) attributes[field.key] = String(value);
      } else if (field.input === 'bool') {
        if (value === true) attributes[field.key] = true;
      }
    }
    result.push({ key, main: !(item && item.main === false), attributes });
  }
  const features = [...new Set((Array.isArray(data.features) ? data.features : []).filter((f) => featureKeys.includes(f)))];
  return { services: result.slice(0, 4), features: features.slice(0, 4) };
}

const normalize = (text) => require('../config/phoneInText').maskPhones(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, MAX_LENGTH);

// text — что человек написал в поле задачи; ip — для лимита. Не бросает: подбор не должен ломать страницу.
async function match({ text, ip }) {
  const clean = normalize(text);
  if (!enabled() || clean.length < MIN_LENGTH) return null;
  const redis = require('../config/redis');
  const cacheKey = 'task_match:' + crypto.createHash('sha1').update(MODEL + '\n' + PROMPT_VERSION + '\n' + clean.toLowerCase()).digest('hex');
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const limitKey = 'task_match_ip:' + String(ip || 'unknown');
    const count = await redis.incr(limitKey);
    if (count === 1) await redis.expire(limitKey, RATE_LIMIT_WINDOW_SECONDS);
    if (count > RATE_LIMIT_MAX) return null;
    const services = await require('./category.service').configForView('ru');
    const sizes = await require('./settings.service').getVanSizeThresholds();
    const { FEATURE_TAGS } = require('../config/service-search-words');
    const features = FEATURE_TAGS.map((f) => ({ key: f.key, label: f.tag.ru }));
    if (!await withinDailyLimit(redis)) return null;
    const prompt = buildPrompt({ text: clean, services, features, sizes });
    const result = sanitize(await (model || callModel)(prompt), services, features.map((f) => f.key));
    if (result) await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    return result;
  } catch (error) {
    console.error('[task-match] failed:', error.message);
    return null;
  }
}

// ---- Шаги 2 и 3: кандидаты из базы и порядок по смыслу ----
// Кандидаты — исполнители каталога города (как на главной, без учёта баланса и тарифов: в бесплатный период
// связаться можно с каждым), у которых есть нужная услуга и характеристики не противоречат требованиям.
// Самые подходящие MAX_CANDIDATES уходят в модель вместе с задачей: номер в базе, услуги, отметки, хэштеги и
// описание — без имён и телефонов. Модель возвращает порядок; сервер оставляет только присланные номера.
const MAX_CANDIDATES = 40;
const RANK_CACHE_TTL_SECONDS = 60 * 60;

// Подходит ли исполнитель услуги под требования: 'ok', 'unknown' (характеристика не указана) или 'no'. Правила
// сравнения — поля услуги из админки (gte / exact / flag), как у фильтров каталога; у перевозки — каждая машина.
function fit(master, service, wanted, fields) {
  const rules = Object.fromEntries((fields || []).map((f) => [f.key, f]));
  const own = master.service_type === service ? master.attributes : ((master.services || []).find((s) => s.service_type === service) || {}).attributes;
  const variants = service === 'van' && master.van_vehicles ? master.van_vehicles : [{ size: master.vehicle_size || undefined, ...(own || {}) }];
  let best = 'no';
  for (const attrs of variants) {
    let unknown = false;
    let fails = false;
    for (const [key, want] of Object.entries(wanted || {})) {
      const rule = rules[key] || {};
      const have = attrs[key];
      if (have === undefined || have === null || have === '') { unknown = true; continue; }
      const options = (rule.options || []).map((o) => o.value);
      const ok = rule.input === 'number' ? (rule.match === 'gte' ? Number(have) >= Number(want) : Number(have) === Number(want))
        : rule.input === 'bool' ? have === true
        : rule.match === 'gte' ? options.indexOf(String(have)) >= options.indexOf(String(want))
        : String(have) === String(want);
      if (!ok) fails = true;
    }
    if (!fails && !unknown) return 'ok';
    if (!fails) best = 'unknown';
  }
  return best;
}

function rerankPrompt(text, lines) {
  return `A customer is typing a task on a Tbilisi marketplace of local services. Below are providers who offer the services the task needs. Order them by how well each one fits THIS task, best first.

Return ONE JSON object and nothing else: {"providers": [<id>, <id>, ...]}

- Use only ids from the list.
- First come providers whose services, characteristics, tags and description match the details of the task: what is moved or done, quantity, floors, special items, equipment.
- Leave a provider out only if the profile clearly shows they cannot do this task.
- Ignore names, languages and prices. Do not guess facts that are not in the profile.

Task:
${text}

Providers:
${lines.join('\n')}`;
}

function sanitizeOrder(raw, ids) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!data || !Array.isArray(data.providers)) return null;
  const allowed = new Set(ids);
  const order = [...new Set(data.providers.map(Number).filter((id) => allowed.has(id)))];
  return order.length ? order : null;
}

// text — задача; locale — язык страницы (подписи и описания кандидатов); citySlug — город каталога.
// Возвращает { services, features, providers: [id по порядку] }; без providers — список собрать не удалось;
// null — ИИ выключен, лимит, сбой разбора.
async function rank({ text, ip, locale = 'ru', citySlug }) {
  const understood = await match({ text, ip });
  if (!understood) return null;
  if (!understood.services.length && !understood.features.length) return { ...understood, providers: [] };
  try {
    const masterService = require('./master.service');
    const categoryService = require('./category.service');
    const cities = await masterService.getActiveCities();
    const city = cities.find((c) => c.slug === citySlug) || cities.find((c) => c.slug === 'tbilisi') || cities[0];
    const [masters, categories, config] = await Promise.all([
      masterService.listMasters({ language: locale, cityId: city && city.id }), categoryService.list(), categoryService.configForView(locale),
    ]);
    categoryService.decorateForCatalog(masters, categories, locale);
    const tags = require('../config/service-search-words').forPage(categories, locale, masters);
    const fieldsByService = Object.fromEntries(config.map((s) => [s.type, s.fields]));
    const scored = [];
    for (const m of masters) {
      const types = [m.service_type, ...(m.services || []).map((s) => s.service_type)];
      const keys = tags.byMaster.get(m.id).keys;
      let score = understood.services.length ? -1 : (understood.features.some((f) => keys.includes(f)) ? 50 : -1);
      for (const service of understood.services) {
        if (!types.includes(service.key)) continue;
        const result = fit(m, service.key, service.attributes, fieldsByService[service.key]);
        if (result === 'no') continue;
        score = Math.max(score, (service.main ? 100 : 40) + (result === 'ok' && Object.keys(service.attributes).length ? 20 : 0));
      }
      if (score < 0) continue;
      score += understood.features.filter((f) => keys.includes(f)).length * 15;
      scored.push({ m, score, display: tags.byMaster.get(m.id).display });
    }
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, MAX_CANDIDATES);
    let providers = candidates.map((c) => c.m.id);
    if (candidates.length > 1) {
      const clean = normalize(text);
      const redis = require('../config/redis');
      const cacheKey = 'task_rank:' + crypto.createHash('sha1').update(MODEL + '\n' + PROMPT_VERSION + '\n' + locale + '\n' + clean.toLowerCase() + '\n' + providers.join(',')).digest('hex');
      const cached = await redis.get(cacheKey);
      if (cached) providers = JSON.parse(cached);
      else if (await withinDailyLimit(redis)) {
        const lines = candidates.map(({ m, display }) => {
          const services = [...new Set([m.service_type, ...(m.services || []).map((s) => s.service_type)])].map((s) => tags.labels[s] || s).join(', ');
          const details = (m.badges || []).join(', ');
          const about = String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 220);
          return `#${m.id} | ${services}${details ? ' (' + details + ')' : ''} | ${display.map((t) => '#' + t.label).join(' ')} | ${about}`;
        });
        // Сбой модели на этом шаге не страшен: остаётся порядок по услугам и характеристикам.
        let order = null;
        try { order = sanitizeOrder(await (model || callModel)(rerankPrompt(clean, lines)), providers); }
        catch (error) { console.error('[task-match] rerank failed:', error.message); }
        if (order) {
          providers = order;
          await redis.set(cacheKey, JSON.stringify(order), 'EX', RANK_CACHE_TTL_SECONDS);
        }
      }
    }
    // Подходящие за пределами MAX_CANDIDATES в модель не идут, но и не пропадают: в конце, в порядке по услугам.
    return { services: understood.services, features: understood.features, providers: [...providers, ...scored.slice(MAX_CANDIDATES).map((c) => c.m.id)] };
  } catch (error) {
    console.error('[task-match] ranking failed:', error.message);
    // Без списка страница остаётся на подборе по словарю.
    return { services: understood.services, features: understood.features };
  }
}

module.exports = { enabled, useModel, buildPrompt, sanitize, match, rank, fit, rerankPrompt, sanitizeOrder, RATE_LIMIT_MAX, MAX_CANDIDATES, DAILY_MODEL_CALLS };
