// Анкеты от SMS-бота владельца (docs/outreach-bot-drafts.md): API для бота /api/outreach/* и страница /c/<token>.
const crypto = require('crypto');
const router = require('express').Router();
const wrap = require('../middleware/asyncHandler');
const redis = require('../config/redis');
const drafts = require('../services/providerDraft.service');
const { requestMeta } = require('../config/requestMeta');
const { translate, clientStrings } = require('../config/i18n');
const pageCopy = require('../config/provider-draft-copy');

const RATE_PER_MINUTE = 60;
const MISSES_PER_HOUR = 30;
const CSRF_COOKIE = 'pdraft_csrf';
const LANGS = ['ka', 'ru', 'en'];

// --- API для бота -----------------------------------------------------------------------------------------

const api = require('express').Router();

api.use(wrap(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Ключ — только в заголовке: адреса запросов попадают в журналы.
  if (req.query.key || req.query.api_key) return res.status(400).json({ error: 'key_in_url', message: 'Send the key in the Authorization header, never in the URL.' });
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match || !await drafts.checkKey(match[1])) return res.status(401).json({ error: 'unauthorized', message: 'Missing or wrong API key.' });
  const window = Math.floor(Date.now() / 60000);
  const key = `outreach_api_rate:${window}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 120);
  if (count > RATE_PER_MINUTE) return res.status(429).json({ error: 'rate_limited', message: `Up to ${RATE_PER_MINUTE} requests per minute.` });
  next();
}));

api.get('/services', wrap(async (req, res) => res.json(await drafts.services())));

api.get('/cities', wrap(async (req, res) => {
  res.json((await drafts.cities()).map(c => ({ id: c.id, slug: c.slug, name: { ka: c.name_ka, ru: c.name_ru, en: c.name_en } })));
}));

api.post('/drafts', wrap(async (req, res) => {
  const result = await drafts.create(req.body);
  res.status(result.created ? 201 : 200).json(drafts.draftResponse(result.draft));
}));

api.patch('/drafts/:id', wrap(async (req, res) => {
  res.json(drafts.draftResponse(await drafts.update(req.params.id, req.body)));
}));

api.get('/status', wrap(async (req, res) => {
  const phone = drafts.normalizePhone(typeof req.query.phone === 'string' ? req.query.phone : '');
  if (!phone) return res.status(400).json({ error: 'invalid_phone', message: 'Query "phone" must be a Georgian number: +995 and 9 digits.' });
  await drafts.expireOld();
  res.json(await drafts.status(phone));
}));

api.get('/changes', wrap(async (req, res) => res.json(await drafts.changes(req.query.since))));

api.post('/optout', wrap(async (req, res) => {
  const phone = drafts.normalizePhone(typeof req.body?.phone === 'string' ? req.body.phone : '');
  if (!phone) return res.status(400).json({ error: 'invalid_phone', message: 'Field "phone" must be a Georgian number: +995 and 9 digits.' });
  res.json(await drafts.optOut(phone, { reason: req.body.reason || '', source: 'bot', meta: requestMeta(req) }));
}));

api.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Unknown endpoint. See docs: GET /api/outreach/services, POST /api/outreach/drafts …' }));

api.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_request', message: 'The request body is not valid JSON.' });
  if (!err || !err.status || !err.code) return next(err);
  res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
});

router.use('/api/outreach', api);

// --- Страница анкеты /c/<token> ---------------------------------------------------------------------------

function pageHeaders(res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
}

// Перебор ссылок: не больше 30 неверных в час с одного адреса.
async function tooManyMisses(req) {
  const key = `pdraft_miss:${requestMeta(req).ip || 'unknown'}`;
  const value = Number(await redis.get(key)) || 0;
  return value >= MISSES_PER_HOUR;
}
async function countMiss(req) {
  const key = `pdraft_miss:${requestMeta(req).ip || 'unknown'}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
}

// «+995 597 •• •• 78»: номер узнаётся, но целиком со страницы не читается.
function maskPhone(phone) {
  const d = String(phone).replace(/\D/g, '').slice(-9);
  return `+995 ${d.slice(0, 3)} •• •• ${d.slice(7)}`;
}

// Какой экран показать по ссылке: анкета, уже подтверждена, удалена, истекла.
async function pageState(draft) {
  if (!draft) return 'notFound';
  if (await drafts.findMaster(draft.phone)) return 'confirmed';
  if (draft.status === 'confirmed') return 'notFound';
  if (draft.status === 'declined' || draft.status === 'opted_out') return 'declined';
  if (draft.status === 'expired' || drafts.draftStatus(draft) === 'expired') return 'expired';
  if (await drafts.findOptOut(draft.phone)) return 'declined';
  return 'form';
}

function pageLang(req, draft) {
  return LANGS.includes(req.query.lang) ? req.query.lang : LANGS.includes(req.body?.lang) ? req.body.lang : draft?.lang || 'ka';
}

router.get('/c/:token', wrap(async (req, res) => {
  pageHeaders(res);
  if (await tooManyMisses(req)) return res.status(429).type('text').send('Too many attempts. Try again in an hour.');
  const draft = await drafts.byToken(req.params.token);
  if (!draft) await countMiss(req);
  const lang = pageLang(req, draft);
  const state = await pageState(draft);
  const t = translate(lang);
  const copy = pageCopy[lang];
  const view = { lang, t, copy, state, token: draft ? draft.token : '', csrf: '', clientStrings: clientStrings(lang) };
  if (state !== 'form') return res.status(state === 'notFound' ? 404 : 200).render('provider-draft', view);
  await drafts.markOpened(draft);
  const csrf = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, csrf, { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: 3600000, path: '/c/' });
  const services = await drafts.services();
  const nameKey = 'name_' + lang;
  res.render('provider-draft', {
    ...view, csrf,
    draft: { ...drafts.json(draft.data, {}), phone: maskPhone(draft.phone) },
    services: services.map(s => ({ code: s.code, name: s.name[lang] || s.name.ru })),
    cities: (await drafts.cities()).map(c => ({ id: c.id, name: c[nameKey] || c.name_ru })),
    languageOptions: require('../config/spokenLanguages').options,
    consent: await require('../services/consent.service').bundle('provider', lang),
  });
}));

// Действие со страницы: проверка ссылки, CSRF и состояния; ошибки — сообщением на языке страницы.
function pageAction(handler) {
  return wrap(async (req, res) => {
    pageHeaders(res);
    if (await tooManyMisses(req)) return res.status(429).json({ success: false, message: 'Too many attempts.' });
    const draft = await drafts.byToken(req.params.token);
    if (!draft) { await countMiss(req); return res.status(404).json({ success: false, message: pageCopy.ka.notFoundTitle }); }
    const lang = pageLang(req, draft);
    const copy = pageCopy[lang];
    // Сначала состояние: по подтверждённой или удалённой анкете действий нет, ответ одинаковый.
    const state = await pageState(draft);
    if (state !== 'form') return res.status(409).json({ success: false, state, message: copy[state + 'Title'] || copy.notFoundTitle });
    if (!req.cookies[CSRF_COOKIE] || req.cookies[CSRF_COOKIE] !== req.body?._csrf) {
      return res.status(403).json({ success: false, message: clientStrings(lang).provider_signup_network || 'Refresh the page' });
    }
    try {
      await handler(req, res, { draft, lang, copy, t: translate(lang), strings: clientStrings(lang) });
    } catch (err) {
      if (!err.status || !err.code) throw err;
      res.status(err.status).json({ success: false, field: err.extra?.field, message: fieldMessage(err, copy, clientStrings(lang)) });
    }
  });
}

function fieldMessage(err, copy, strings) {
  const field = err.extra?.field;
  if (err.code === 'description_has_phone') return strings.join_description_phone;
  if (field === 'name') return copy.needName;
  if (field === 'services' || field === 'other_services') return copy.needService;
  if (field === 'description') return strings.join_services_required;
  if (field === 'city') return strings.join_work_cities_required;
  if (field === 'languages') return strings.join_languages_required;
  return strings.provider_signup_network;
}

// Сохранить правки без кода (кнопка «Подтвердить» сначала сохраняет, затем просит код).
router.post('/c/:token/save', pageAction(async (req, res, { draft, copy }) => {
  await drafts.saveEdits(draft, await drafts.fromPage(req.body));
  res.json({ success: true, message: copy.saved });
}));

// «Подтвердить»: правки сохраняются, галочки снимаются в снимок согласия, на номер уходит код с сайта.
router.post('/c/:token/code', pageAction(async (req, res, { draft, lang, strings }) => {
  await drafts.saveEdits(draft, await drafts.fromPage(req.body, { final: true }));
  const accepted = await require('../services/consent.service').acceptedRequest({ body: { ...req.body, consentLanguage: lang } }, 'provider');
  if (accepted.error) return res.status(accepted.status).json({ success: false, message: accepted.error });
  // В снимке согласия видно, что регистрация шла по ссылке на анкету от бота.
  const consent = { ...accepted.consent, signup_path: 'outreach_draft', draft_id: draft.public_id };
  const otp = require('../services/otp.service');
  const result = await otp.sendCode(draft.phone, 'master', null, { meta: requestMeta(req), consent });
  if (!result.success) {
    const serviceMessage = require('../config/service-message-copy');
    return res.status(result.reason === 'rate_limited' ? 429 : 503).json({ success: false, message: serviceMessage(result.reason === 'rate_limited' ? 'rateLimit' : 'sendFailed', lang) });
  }
  res.json({ success: true, challengeId: result.challengeId, sentTo: strings.otp_sent_to ? strings.otp_sent_to.replace('{phone}', maskPhone(draft.phone)) : '' });
}));

// Код верный → обычная регистрация с данными анкеты, модерация, вход в кабинет.
router.post('/c/:token/confirm', pageAction(async (req, res, { draft, lang, copy }) => {
  const otp = require('../services/otp.service');
  const serviceMessage = require('../config/service-message-copy');
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const challengeId = typeof req.body.challengeId === 'string' ? req.body.challengeId : '';
  if (!/^\d{4}$/.test(code)) return res.status(400).json({ success: false, message: serviceMessage('invalidCode', lang) });
  const valid = await otp.verifyCode(draft.phone, code, 'master', { meta: requestMeta(req), language: lang, strict: true, challengeId });
  if (!valid) return res.status(400).json({ success: false, message: serviceMessage('invalidCode', lang) });
  const grant = await otp.getConsentGrant(draft.phone, 'master', challengeId);
  if (!grant) return res.status(400).json({ success: false, message: serviceMessage('unverified', lang) });
  let master;
  try {
    master = await drafts.complete(draft, grant, { meta: requestMeta(req), copy });
  } catch (err) {
    if (err.code === 'MASTER_ALREADY_REGISTERED') return res.status(409).json({ success: false, message: clientStrings(lang).join_existing_profile });
    if (err.code === 'DESCRIPTION_HAS_PHONE') return res.status(400).json({ success: false, message: clientStrings(lang).join_description_phone });
    throw err;
  }
  const cabinet = require('../controllers/master.controller');
  await cabinet.afterRegistration(master, draft.phone, grant, challengeId, req);
  await cabinet.announceRegistration(master, draft.phone, req, res, lang);
  const leadSms = grant.snapshot?.choices?.lead_sms === true;
  // Ссылка на кабинет — путь на том же адресе, где открыта анкета: там и стоит cookie входа.
  res.json({ success: true, link: '/master/' + master.master_token, leadSms, message: copy.doneTitle });
}));

// «Не интересно, удалите мои данные»: анкета стирается, номер — в список отказа.
router.post('/c/:token/decline', pageAction(async (req, res, { draft, copy }) => {
  await drafts.optOut(draft.phone, { reason: 'Не интересно (страница анкеты)', source: 'page', meta: requestMeta(req) });
  res.json({ success: true, message: copy.declinedText });
}));

module.exports = router;
