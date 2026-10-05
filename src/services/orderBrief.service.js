const axios = require('axios');
const pool = require('../config/db');
const { VAN_SIZE_ORDER } = require('../config/serviceTypes');

// Карточка «Кратко»: ИИ раскладывает текст заявки по полям (что, откуда, куда, этаж и лифт,
// размеры, когда, бюджет), подсказывает менеджеру услуги и класс кузова и перечисляет, чего в
// заявке не хватает. Правила:
//  - только факты из текста заказчика и уточнения менеджера, ничего не додумывать;
//  - исполнители видят карточку лишь после того, как менеджер разрешил показ (brief.shared), и
//    всегда рядом с исходным текстом;
//  - подсказки услуг и класса ничего не отмечают сами: менеджер нажимает кнопку.
// Тот же OpenRouter, что и перевод заявок (translation.service). Без OPENROUTER_API_KEY сервис
// работает вхолостую: карточки нет, экран менеджера показывает заявку как раньше.
const MODEL = process.env.OPENROUTER_BRIEF_MODEL || process.env.OPENROUTER_TRANSLATION_MODEL || 'google/gemini-2.5-flash-lite';
const KEY = process.env.OPENROUTER_API_KEY;
const CALL_TIMEOUT_MS = 20000;
const FIELDS = ['what', 'from', 'to', 'access', 'size', 'when', 'budget', 'other'];
const LANGS = ['ka', 'ru', 'en'];
const LANG_NAME = { ka: 'Georgian', ru: 'Russian', en: 'English' };

function buildPrompt({ description, note, district, lang, services, sizes }) {
  return `You prepare a short structured card of a customer request for a Tbilisi marketplace of movers, loaders, tow trucks and other services. A manager and the providers read the card next to the original text.

Use ONLY facts written in the request and in the manager's clarification. Never guess, never add details, never promise a price. If something is not stated, leave it out.

Return ONE JSON object and nothing else:
{"fields": {"<field>": {"ru": "...", "ka": "...", "en": "..."}}, "services": ["<service key>"], "sizes": ["<class>"], "missing": ["..."], "questions": "..."}

fields - include a field only if the text states it. Each value is a short phrase (up to 120 characters): the same fact in Russian, Georgian and English. Keep numbers, dates, times, prices, street and place names exactly; write place names in each language's script.
  what   - what has to be moved or done (items, quantity)
  from   - pickup address or area
  to     - destination address or area
  access - floors, elevator, carrying distance, parking
  size   - dimensions, weight or volume of the cargo
  when   - date and time
  budget - price or budget named by the customer
  other  - anything else a provider must know

services - keys from this list that the customer clearly asks for, [] if unclear: ${services.map(s => `${s.key} = ${s.name}`).join('; ')}
sizes - vehicle body classes that fit the cargo, ONLY when the cargo dimensions are stated, otherwise []: ${sizes.map(s => `${s.code} = body from ${s.length}x${s.width}x${s.height} cm`).join('; ')}
missing - up to 5 short Russian phrases naming important facts the request does not state (for example "этаж и лифт", "дата и время", "размеры груза", "адрес доставки"). Only facts that matter for the requested services.
questions - one short polite message to the customer asking for the missing facts, written in ${LANG_NAME[lang] || 'the language of the request'}. Empty string if nothing is missing.

District chosen by the customer: ${district || 'not given'}
Request:
${description}
Manager's clarification:
${note || 'none'}`;
}

async function callModel(prompt) {
  // Запас по длине: карточка на трёх языках, грузинский текст расходует токены быстрее.
  const body = { model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 3000 };
  const send = extra => axios.post('https://openrouter.ai/api/v1/chat/completions', { ...body, ...extra },
    { headers: { Authorization: `Bearer ${KEY}`, 'HTTP-Referer': 'https://xtender.ge', 'X-Title': 'xtender.ge' }, timeout: CALL_TIMEOUT_MS });
  let res;
  try { res = await send({ response_format: { type: 'json_object' } }); }
  catch (error) {
    // Модель или провайдер могут не принимать response_format — тогда просим JSON только словами подсказки.
    if (error.response?.status !== 400) throw error;
    res = await send({});
  }
  return res.data.choices?.[0]?.message?.content || '';
}
// Тесты и локальная демонстрация подставляют свою модель вместо обращения к OpenRouter.
let model = null;
const useModel = fn => { model = fn; };
const enabled = () => Boolean(model || KEY);

const short = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Ответ модели не доверяем: оставляем только известные поля, услуги и классы, режем длину.
function sanitize(raw, serviceKeys) {
  const start = String(raw || '').indexOf('{'), end = String(raw || '').lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(String(raw).slice(start, end + 1)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fields = {};
  for (const key of FIELDS) {
    const value = data.fields?.[key];
    if (!value || typeof value !== 'object') continue;
    const texts = Object.fromEntries(LANGS.map(lang => [lang, short(value[lang], 200)]).filter(([, text]) => text));
    if (Object.keys(texts).length) fields[key] = texts;
  }
  const list = (value, allowed) => [...new Set(Array.isArray(value) ? value.filter(item => allowed.includes(item)) : [])];
  return {
    version: 1, fields,
    services: list(data.services, serviceKeys), sizes: VAN_SIZE_ORDER.filter(size => list(data.sizes, VAN_SIZE_ORDER).includes(size)),
    missing: (Array.isArray(data.missing) ? data.missing : []).map(item => short(item, 80)).filter(Boolean).slice(0, 5),
    questions: short(data.questions, 500), shared: false,
  };
}

async function generate(order) {
  if (!enabled() || !String(order?.description || '').trim()) return null;
  const groups = await require('./category.service').groups();
  const services = Object.entries(groups).filter(([key]) => key !== 'flatbed').map(([key, name]) => ({ key, name }));
  const sizes = await require('./settings.service').getVanSizeThresholds();
  const lang = require('./translation.service').detectLang(order.description);
  const prompt = buildPrompt({ description: order.description, note: order.manager_note, district: order.district_name, lang, services, sizes });
  const brief = sanitize(await (model || callModel)(prompt, order), services.map(s => s.key));
  return brief && { ...brief, generated_at: new Date().toISOString() };
}

// Собирает карточку заново и сохраняет её, только если текст за это время не изменился. Не бросает:
// от карточки не зависят ни создание заявки, ни рассылка.
async function refresh(orderId) {
  try {
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
    if (!order) return null;
    const brief = await generate(order);
    if (!brief) return null;
    const saved = await pool.query("UPDATE orders SET brief=$1::jsonb WHERE id=$2 AND description=$3 AND COALESCE(manager_note,'')=$4 RETURNING id",
      [JSON.stringify(brief), order.id, order.description, order.manager_note || '']);
    return saved.rows[0] ? brief : null;
  } catch (error) {
    console.error('[brief] failed:', error.response?.status || '', error.message);
    return null;
  }
}

const read = order => typeof order?.brief === 'string' ? JSON.parse(order.brief) : order?.brief || null;

// Менеджер проверил карточку и разрешает (или запрещает) показывать её исполнителям.
async function setShared(token, shared) {
  return pool.withTransaction(async client => {
    const order = (await client.query('SELECT id, brief FROM orders WHERE token=$1 FOR UPDATE', [token])).rows[0];
    const brief = read(order);
    if (!brief) return false;
    await client.query('UPDATE orders SET brief=$1::jsonb WHERE id=$2', [JSON.stringify({ ...brief, shared: shared === true }), order.id]);
    return true;
  });
}

// Строки карточки на нужном языке; если перевода поля нет — на языке, который есть.
function lines(brief, lang) {
  if (!brief?.fields) return [];
  return FIELDS.filter(key => brief.fields[key]).map(key => ({ key, text: brief.fields[key][lang] || brief.fields[key].ru || Object.values(brief.fields[key])[0] }));
}

module.exports = { FIELDS, enabled, useModel, buildPrompt, sanitize, generate, refresh, read, setShared, lines };
