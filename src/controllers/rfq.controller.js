// API заявок для ИИ-ассистентов (свой GPT в ChatGPT и т. п.): POST /v1/rfq/create и /v1/rfq/:rfq_id/verify,
// описание для моделей — GET /openapi.json и /llms.txt. Заявка идёт тем же путём, что с формы на сайте:
// черновик, код по SMS, подтверждение, модератор. Без кода заявка никому не уходит: иначе любой мог бы
// вписать чужой номер. Описание — docs/ai-agent-api.md.
const agentApi = require('../config/agentApi');
const consentService = require('../services/consent.service');
const consentLog = require('../services/consentLog.service');
const otpService = require('../services/otp.service');
const orderService = require('../services/order.service');
const legalContentService = require('../services/legalContent.service');
const categoryService = require('../services/category.service');
const masterService = require('../services/master.service');
const servicePages = require('../services/servicePages.service');
const { announceConfirmed } = require('./order.controller');
const redis = require('../config/redis');
const { requestMeta } = require('../config/requestMeta');
const { toE164, isGeorgianPhone } = require('../config/phone');
const { getBaseUrl } = require('../config/url');
const { localizedPath } = require('../config/seo');

const LANGS = ['ka', 'ru', 'en'];
const CODE_TTL_SECONDS = 300; // как у кода в otp.service
// Сколько кодов в час API отправит с одного IP. Номер ограничен отдельно (3 кода в час, otp.service).
// Запросы GPT приходят с серверов OpenAI, у многих людей один IP: упрёмся — поднять.
const IP_LIMIT_PER_HOUR = 30;
const NAME_LABEL = { ka: 'სახელი', ru: 'Имя', en: 'Name' };
const CATALOG_TTL_MS = 10 * 60 * 1000;

const fail = (res, status, error, message, field) => res.status(status).json({ success: false, error, message, ...(field ? { field } : {}) });
const text = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const hasWords = (value) => (value.match(/\p{L}/gu) || []).length >= 2;

// Проверка и сборка текста заявки. Ошибка — { field, message } по-английски: её читает модель.
function parseCreate(body) {
  const category = text(body.category);
  if (!category || category.length > 80 || !hasWords(category)) return { field: 'category', message: 'category is required: the kind of service, up to 80 characters.' };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) return { field: 'items', message: 'items must list from 1 to 30 things that are needed.' };
  const items = [];
  for (const raw of body.items) {
    const name = text(raw && raw.name), quantity = text(raw && raw.quantity);
    if (!name || name.length > 200 || !hasWords(name)) return { field: 'items', message: 'Each item needs a name in words, up to 200 characters.' };
    if (quantity.length > 60) return { field: 'items', message: 'quantity is up to 60 characters.' };
    items.push({ name, quantity });
  }
  const details = typeof body.details === 'string' ? body.details.trim() : '';
  if (details.length > 2000) return { field: 'details', message: 'details is up to 2000 characters.' };
  const district = text(body.district), city = text(body.city), name = text(body.customer_name);
  if (!district || district.length > 120) return { field: 'district', message: 'district is required: a district or address, up to 120 characters.' };
  if (city.length > 60) return { field: 'city', message: 'city is up to 60 characters.' };
  if (name.length > 80) return { field: 'customer_name', message: 'customer_name is up to 80 characters.' };
  const phone = toE164(body.customer_phone);
  if (typeof body.customer_phone !== 'string' || !isGeorgianPhone(phone)) {
    return { field: 'customer_phone', message: 'customer_phone must be a Georgian mobile number: +995 and 9 digits, for example +995599123456.' };
  }
  const language = body.language === undefined ? 'en' : body.language;
  if (!LANGS.includes(language)) return { field: 'language', message: 'language is one of ka, ru, en.' };

  const description = [category, ...items.map((item) => `- ${item.name}${item.quantity ? ' — ' + item.quantity : ''}`),
    ...(details ? [details] : []), ...(name ? [`${NAME_LABEL[language]}: ${name}`] : [])].join('\n');
  return { request: { category, items, details, district, city, name, phone, language, description,
    districtName: [district, city].filter(Boolean).join(', ') } };
}

async function underIpLimit(req) {
  const key = `rfq_api_ip:${req.ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  return count <= IP_LIMIT_PER_HOUR;
}

async function create(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = parseCreate(body);
  if (parsed.field) return fail(res, 400, 'invalid_request', parsed.message, parsed.field);
  if (body.terms_accepted !== true || body.privacy_accepted !== true) {
    return fail(res, 400, 'consent_required', 'Show the user the Terms of Service and the Privacy Policy and ask if they agree. '
      + 'Send terms_accepted and privacy_accepted as true only if they did.', body.terms_accepted !== true ? 'terms_accepted' : 'privacy_accepted');
  }
  const request = parsed.request, meta = requestMeta(req);
  if (!await underIpLimit(req)) return fail(res, 429, 'rate_limited', 'Too many requests from this client. Try again in an hour.');

  // Согласие: человек не видел галочек на сайте, о его согласии сообщает ассистент. Так и записываем.
  const consent = { ...(await consentService.bundle('client', request.language)), acceptance_method: 'ai_agent_reported' };
  let order = await orderService.reusePendingOrder(body.rfq_id, request.phone, request.description);
  if (!order) {
    order = await orderService.createPendingOrder({ phone: request.phone, description: request.description,
      districtName: request.districtName, source: agentApi.SOURCE });
  }
  // Что прислал ассистент — до отправки кода, как пришло.
  await consentLog.recordAction({ eventType: 'ORDER_REQUESTED_VIA_API', phone: request.phone, orderId: order.id, channel: 'api', meta,
    metadata: { category: request.category, items: request.items, details: request.details, district: request.district, city: request.city,
      customer_name: request.name, language: request.language, terms_accepted: true, privacy_accepted: true } }).catch((err) => console.error('API request log failed:', err.message));

  const sent = await otpService.sendCode(request.phone, 'order', order.id, { meta, consent, viaAssistant: true });
  if (!sent.success) {
    if (sent.reason === 'rate_limited') return fail(res, 429, 'rate_limited', 'Too many codes for this phone number. Try again in an hour.');
    return fail(res, 502, 'sms_failed', 'The SMS was not sent. Try again later.');
  }
  return res.json({
    success: true,
    rfq_id: order.token,
    status: agentApi.statusOf(order),
    challenge_id: sent.challengeId,
    expires_in_seconds: CODE_TTL_SECONDS,
    next_step: `A 4-digit code was sent by SMS to ${request.phone}. Ask the user for it and call verifyRequest with rfq_id ${order.token}.`,
  });
}

async function verify(req, res) {
  const order = await orderService.getOrderByToken(String(req.params.rfq_id || '').slice(0, 40));
  if (!order) return fail(res, 404, 'not_found', 'No request with this rfq_id.');
  if (order.status !== 'unverified') return fail(res, 409, 'already_confirmed', 'This request is already confirmed or closed.');
  const code = text(req.body && req.body.code), challengeId = text(req.body && req.body.challenge_id);
  if (!/^\d{4}$/.test(code) || !challengeId) return fail(res, 400, 'invalid_request', 'Send code (4 digits from SMS) and challenge_id from createRequest.');

  const meta = requestMeta(req);
  const { version: termsVersion } = await legalContentService.getTerms();
  const valid = await otpService.verifyCode(order.phone, code, 'order', { meta, termsVersion, challengeId, strict: true });
  if (!valid) {
    return fail(res, 400, 'invalid_code', 'Wrong or expired code. Ask the user to check the SMS. To send a new code, call createRequest again with the same data and this rfq_id.');
  }
  const grant = await otpService.getConsentGrant(order.phone, 'order', challengeId);
  const confirmed = await orderService.activateOrder(order.token, order.phone, grant, meta, []);
  // Код подошёл, но был отправлен к другой заявке с этого номера (на сайте запросили код позже).
  if (!confirmed) return fail(res, 409, 'code_for_other_request', 'This code belongs to another request from this phone number. Call createRequest again with this rfq_id.');
  await otpService.clearConsentGrant(order.phone, 'order', challengeId);
  announceConfirmed(confirmed);

  return res.json({
    success: true,
    rfq_id: confirmed.token,
    status: agentApi.statusOf(confirmed),
    tracking_url: `${getBaseUrl()}/o/${confirmed.owner_token}`,
    message: 'The request is confirmed. A moderator checks it and sends it to matching providers; they contact the customer by phone. '
      + 'The customer can see the status and close the request at tracking_url (the link is also sent by SMS).',
  });
}

// Услуги, у которых сейчас есть исполнители, по городам — из того же каталога, что страницы «услуга + город».
// Запоминаем на 10 минут: эти адреса читают роботы.
let catalogCache = null;
async function liveCatalog() {
  if (catalogCache && catalogCache.until > Date.now()) return catalogCache.value;
  const [categories, cities] = await Promise.all([categoryService.list(), masterService.getActiveCities()]);
  const value = [];
  for (const city of cities) {
    const pages = servicePages.forCity(categories, city, await masterService.listMasters({ cityId: city.id }));
    if (!pages.length) continue;
    value.push({ name: city.name_en || city.name_ru, services: pages.map((page) => ({
      code: page.category.slug, label: page.category.name_en || page.category.name_ru, count: page.count,
      url: page.indexable ? getBaseUrl() + localizedPath('en', '/s/' + page.slug) : null })) });
  }
  catalogCache = { value, until: Date.now() + CATALOG_TTL_MS };
  return value;
}

// Сбой подсчёта каталога описание не роняет: без списка услуг оно всё равно верное.
async function catalogOrEmpty() {
  try { return await liveCatalog(); } catch (err) { console.error('Agent API catalog unavailable:', err.message); return []; }
}

async function openapi(req, res) {
  res.json(agentApi.openapi(getBaseUrl(), await catalogOrEmpty()));
}

async function llmsTxt(req, res) {
  res.type('text/plain; charset=utf-8').send(agentApi.llmsText(getBaseUrl(), await catalogOrEmpty()));
}

module.exports = { create, verify, openapi, llmsTxt, parseCreate, _resetCatalog: () => { catalogCache = null; } };
