// Вход OAuth для API v1 и плагина ChatGPT (docs/api-v1/AUTH.md). Метаданные сервера авторизации и защищённого
// ресурса, регистрация клиента (RFC 7591), страница входа по номеру и коду из SMS, обмен кода на токены,
// отзыв (RFC 7009). Номер и код вводятся только на этой странице, в чат их не просят.
const { randomBytes } = require('node:crypto');
const redis = require('../config/redis');
const apiConfig = require('../config/apiV1');
const oauthService = require('../services/oauth.service');
const otpService = require('../services/otp.service');
const accountService = require('../services/account.service');
const { OAuthError } = oauthService;
const { getBaseUrl } = require('../config/url');
const { toE164, isGeorgianPhone, georgianPhoneError } = require('../config/phone');
const { requestMeta } = require('../config/requestMeta');
const { localizedPath } = require('../config/seo');
const { normalizeLang } = require('../config/i18n');
const serviceMessage = require('../config/service-message-copy');
const oauthCopy = require('../config/oauth-copy');

const REQUEST_TTL_SECONDS = 15 * 60;
const COOKIE = 'oauth_request';
const LIMITS = { register: [20, 3600], authorize: [60, 3600], phone: [10, 3600], token: [120, 60] };

// --- Метаданные --------------------------------------------------------------------------------------------
function noStore(res) { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); }

function authorizationServerMetadata() {
  const base = getBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: base + '/oauth/authorize',
    token_endpoint: base + '/oauth/token',
    registration_endpoint: base + '/oauth/register',
    revocation_endpoint: base + '/oauth/revoke',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: apiConfig.activeScopes(),
    authorization_response_iss_parameter_supported: true,
    ui_locales_supported: ['ka', 'ru', 'en'],
    service_documentation: base + apiConfig.PREFIX + '/openapi.json',
  };
}

function authorizationServer(req, res) {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(authorizationServerMetadata());
}

// RFC 9728: /.well-known/oauth-protected-resource — REST API (/api/v1); …/mcp — будущий MCP-адаптер.
function protectedResource(kind) {
  return (req, res) => {
    const base = getBaseUrl();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      resource: apiConfig.resources()[kind],
      authorization_servers: [base],
      scopes_supported: apiConfig.activeScopes(),
      bearer_methods_supported: ['header'],
      resource_name: 'xtender.ge',
      resource_documentation: base + apiConfig.PREFIX + '/openapi.json',
      resource_policy_uri: base + '/en/privacy',
      resource_tos_uri: base + '/en/terms',
    });
  };
}

// --- Ограничение частоты по адресу -----------------------------------------------------------------------------
async function overLimit(kind, req) {
  const [max, window] = LIMITS[kind];
  const key = `oauth_limit:${kind}:${req.ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, window);
  return count > max;
}

function oauthError(res, error) {
  noStore(res);
  return res.status(error.status || 400).json({ error: error.error, error_description: error.message });
}

// --- Регистрация клиента ---------------------------------------------------------------------------------------
async function register(req, res) {
  noStore(res);
  if (await overLimit('register', req)) return res.status(429).set('Retry-After', '3600').json({ error: 'slow_down', error_description: 'Too many registrations from this address.' });
  try {
    return res.status(201).json(await oauthService.registerClient(req.body || {}));
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(res, error);
    throw error;
  }
}

// --- Страница входа ----------------------------------------------------------------------------------------------
function pageLang(req, explicit) {
  const wanted = String(explicit || req.query?.ui_locales || '').split(/\s+/).map((s) => s.slice(0, 2).toLowerCase()).find((s) => ['ka', 'ru', 'en'].includes(s));
  return normalizeLang(wanted || req.lang);
}

function render(req, res, status, view) {
  const lang = view.lang;
  const request = view.request || null;
  noStore(res);
  res.set('Referrer-Policy', 'no-referrer');
  return res.status(status).render('oauth-authorize', {
    lang, c: oauthCopy.copy(lang), sandbox: apiConfig.isSandbox(),
    step: view.step, error: view.error || null, request, requestId: view.requestId || '',
    scopes: request ? request.scope.split(' ').map((scope) => apiConfig.SCOPES[scope]?.[lang] || scope) : [],
    host: request ? new URL(request.redirect_uri).host : '',
    maskedPhone: view.phone ? accountService.maskedPhone(view.phone) : '', phoneInput: view.phoneInput || '',
    providerStatus: view.providerStatus || null,
    providerStatusLabel: view.providerStatus ? oauthCopy.COPY[lang].provider_status[view.providerStatus] : '',
    legal: { terms: localizedPath(lang, '/terms'), privacy: localizedPath(lang, '/privacy') },
  });
}

const pendingKey = (id) => 'oauth_req:' + id;
async function savePending(id, pending) {
  await redis.set(pendingKey(id), JSON.stringify(pending), 'EX', REQUEST_TTL_SECONDS);
}

// Запрос входа живёт в Redis и привязан к куке этой вкладки: чужая страница не может довести вход за человека.
async function loadPending(req) {
  const id = typeof req.body?.request_id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(req.body.request_id) ? req.body.request_id : null;
  if (!id) return { failure: 'expired' };
  if (req.cookies?.[COOKIE] !== id || req.get('sec-fetch-site') === 'cross-site') return { failure: 'forbidden' };
  const raw = await redis.get(pendingKey(id));
  if (!raw) return { failure: 'expired' };
  return { id, pending: JSON.parse(raw) };
}

function failurePage(req, res, failure) {
  const lang = pageLang(req, req.body?.lang);
  return render(req, res, failure === 'forbidden' ? 403 : 400, { lang, step: 'error', error: oauthCopy.copy(lang)(failure) });
}

async function authorize(req, res) {
  const lang = pageLang(req);
  const result = await oauthService.validateAuthorizationRequest(req.query || {});
  if (result.error && !result.redirect) {
    return render(req, res, 400, { lang, step: 'error', error: oauthCopy.copy(lang)('bad_request') + ` (${result.error})` });
  }
  if (result.error) {
    noStore(res);
    return res.redirect(302, oauthService.redirectWith(result.redirectUri, { error: result.error, error_description: result.description, state: result.state }));
  }
  // Каждое открытие страницы входа — запись в Redis на 15 минут: число открытий с одного адреса ограничено.
  if (await overLimit('authorize', req)) return render(req, res, 429, { lang, step: 'error', error: serviceMessage('rateLimit', lang) });
  const id = randomBytes(24).toString('base64url');
  await savePending(id, { request: result.request, lang, step: 'phone' });
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), path: '/oauth', maxAge: REQUEST_TTL_SECONDS * 1000 });
  return render(req, res, 200, { lang, step: 'phone', request: result.request, requestId: id });
}

async function authorizePhone(req, res) {
  const { id, pending, failure } = await loadPending(req);
  if (failure) return failurePage(req, res, failure);
  const { lang, request } = pending;
  const raw = typeof req.body.phone === 'string' ? req.body.phone.slice(0, 40) : '';
  const phone = toE164(raw);
  const page = (error) => render(req, res, 400, { lang, step: 'phone', request, requestId: id, error, phoneInput: raw });
  if (!isGeorgianPhone(phone)) return page(georgianPhoneError(lang));
  if (await overLimit('phone', req)) return page(serviceMessage('rateLimit', lang));
  const sent = await otpService.sendCode(phone, 'oauth', null, { meta: requestMeta(req), language: lang });
  if (!sent.success) return page(serviceMessage(sent.reason === 'rate_limited' ? 'rateLimit' : 'sendFailed', lang));
  await savePending(id, { ...pending, phone, step: 'code' });
  return render(req, res, 200, { lang, step: 'code', request, requestId: id, phone });
}

async function authorizeCode(req, res) {
  const { id, pending, failure } = await loadPending(req);
  if (failure) return failurePage(req, res, failure);
  const { lang, request, phone } = pending;
  if (req.body.action === 'change' || !phone) {
    await savePending(id, { request, lang, step: 'phone' });
    return render(req, res, 200, { lang, step: 'phone', request, requestId: id });
  }
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const { version: termsVersion } = await require('../services/legalContent.service').getTerms();
  const ok = /^\d{4}$/.test(code) && await otpService.verifyCode(phone, code, 'oauth', {
    meta: requestMeta(req), language: lang, termsVersion,
    metadata: { client_id: request.client_id, client_name: request.client_name, scope: request.scope },
  });
  if (!ok) return render(req, res, 400, { lang, step: 'code', request, requestId: id, phone, error: serviceMessage('invalidCode', lang) });
  await otpService.clearVerified(phone, 'oauth');
  await savePending(id, { ...pending, verified: true, step: 'consent' });
  const { providerStatus } = await accountService.roles({ phone });
  return render(req, res, 200, { lang, step: 'consent', request, requestId: id, phone, providerStatus });
}

async function authorizeDecision(req, res) {
  const { id, pending, failure } = await loadPending(req);
  if (failure) return failurePage(req, res, failure);
  if (!pending.verified || !pending.phone) return failurePage(req, res, 'expired');
  await redis.del(pendingKey(id));
  res.clearCookie(COOKIE, { path: '/oauth' });
  noStore(res);
  const { request } = pending;
  if (req.body.decision !== 'allow') {
    return res.redirect(302, oauthService.redirectWith(request.redirect_uri, { error: 'access_denied', error_description: 'The user did not allow access.', state: request.state }));
  }
  const account = await accountService.ensureForVerifiedPhone(pending.phone, { locale: pending.lang });
  const code = await oauthService.approve(request, account.id);
  return res.redirect(302, oauthService.redirectWith(request.redirect_uri, { code, state: request.state }));
}

// --- Токены ------------------------------------------------------------------------------------------------------
async function token(req, res) {
  noStore(res);
  if (await overLimit('token', req)) return res.status(429).set('Retry-After', '60').json({ error: 'slow_down', error_description: 'Too many token requests from this address.' });
  const body = req.body || {};
  try {
    if (typeof body.client_id !== 'string') throw new OAuthError('invalid_client', 'client_id is required.', 401);
    if (body.grant_type === 'authorization_code') return res.json(await oauthService.exchangeCode(body));
    if (body.grant_type === 'refresh_token') return res.json(await oauthService.refresh(body));
    throw new OAuthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token.');
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(res, error);
    throw error;
  }
}

async function revoke(req, res) {
  noStore(res);
  const body = req.body || {};
  if (typeof body.token !== 'string') return res.status(400).json({ error: 'invalid_request', error_description: 'token is required.' });
  await oauthService.revokeToken(body);
  return res.status(200).json({});
}

module.exports = {
  authorizationServerMetadata, authorizationServer, protectedResource, register, authorize, authorizePhone, authorizeCode,
  authorizeDecision, token, revoke, COOKIE,
};
