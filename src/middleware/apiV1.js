// Общий слой API v1: request_id в каждом ответе, единый формат ошибок (ТЗ, раздел 5), проверка токена OAuth и
// области доступа, лимит запросов, версии объектов (ETag / If-Match). Описание — docs/api-v1/README.md.
const { randomBytes } = require('node:crypto');
const redis = require('../config/redis');
const apiConfig = require('../config/apiV1');
const { getBaseUrl } = require('../config/url');

class ApiError extends Error {
  // fields — [{ path, code }] для 422; details — любые дополнительные поля ответа (актуальная версия и т. п.).
  constructor(status, code, message, { fields, retryable = false, details, headers } = {}) {
    super(message);
    Object.assign(this, { status, code, fields, retryable, details, headers });
  }
}
const fail = (...args) => new ApiError(...args);

function requestId(req, res, next) {
  req.requestId = 'req_' + randomBytes(9).toString('base64url');
  res.set('X-Request-Id', req.requestId);
  res.set('X-Xtender-Environment', apiConfig.environment());
  // По умолчанию ответ личный: общие справочники разрешают кеш явно (publicCache).
  res.set('Cache-Control', 'private, no-store');
  const started = Date.now();
  // В журнал — метод, путь без строки запроса и статус: ни токенов, ни номеров, ни текста задачи.
  res.on('finish', () => console.log(`[api] ${req.requestId} ${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${Date.now() - started}ms`
    + (apiConfig.isSandbox() ? ' sandbox' : '')));
  next();
}

function send(req, res, status, body) {
  return res.status(status).json({ ...body, request_id: req.requestId });
}

function publicCache(res, seconds = 60) {
  res.set('Cache-Control', `public, max-age=${seconds}`);
  res.set('Vary', 'Authorization, Accept-Language');
}

function protectedResourceMetadataUrl() {
  return getBaseUrl() + '/.well-known/oauth-protected-resource' + apiConfig.PREFIX;
}

function challenge(error, description, scope) {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl()}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description}"`);
  if (scope) parts.push(`scope="${scope}"`);
  return 'Bearer ' + parts.join(', ');
}

function unauthorized(error, description) {
  return fail(401, 'UNAUTHORIZED', description || 'Authorization required: connect your Xtender account (OAuth).',
    { headers: { 'WWW-Authenticate': challenge(error, description) } });
}

// optional — запрос без токена допустим (общий ответ /capabilities, справочники), но неверный токен — всегда 401.
function authenticate({ optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization');
      if (!header) {
        if (optional) return next();
        throw unauthorized(null, null);
      }
      const match = /^Bearer\s+([A-Za-z0-9._~-]{20,200})$/.exec(header.trim());
      if (!match) throw unauthorized('invalid_request', 'Use the Authorization: Bearer <access token> header.');
      const session = await require('../services/oauth.service').verifyAccessToken(match[1]);
      if (!session) throw unauthorized('invalid_token', 'The access token is invalid, expired or revoked.');
      req.auth = session;
      await rateLimit(session.grant.id);
      return next();
    } catch (error) { return next(error); }
  };
}

async function rateLimit(grantId) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `api_rate:${grantId}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 90);
  if (count > apiConfig.RATE_LIMIT_PER_MINUTE) {
    const retryAfter = Math.max(1, 60 - Math.floor((Date.now() % 60000) / 1000));
    throw fail(429, 'RATE_LIMITED', 'Too many requests for this session. Retry later.', { retryable: true, headers: { 'Retry-After': String(retryAfter) } });
  }
}

// Область доступа проверяется вместе с ролью и доступом к объекту в самом обработчике (ТЗ, раздел 4).
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized(null, null));
    if (!req.auth.scopes.has(scope)) {
      return next(fail(403, 'INSUFFICIENT_SCOPE', `This action needs the "${scope}" scope. Reconnect the account and allow it.`,
        { headers: { 'WWW-Authenticate': challenge('insufficient_scope', `The "${scope}" scope is required.`, scope) } }));
    }
    return next();
  };
}

// Запись разрешена только действующему аккаунту: «только чтение» читает свой профиль, но ничего не меняет.
// Заблокированный сюда не доходит: его токены не принимает oauth.service.verifyAccessToken.
function requireActiveAccount(req, res, next) {
  if (req.auth?.account?.status !== 'active') return next(fail(403, 'ACCOUNT_READ_ONLY', 'This account is read-only; changes are not allowed.'));
  return next();
}

function setVersion(res, version) {
  res.set('ETag', `"${version}"`);
}

// If-Match: "3", 3 или W/"3". Без заголовка правка не принимается (428): иначе два клиента молча затирали бы друг друга.
function expectedVersion(req) {
  const raw = req.get('if-match');
  if (!raw) throw fail(428, 'PRECONDITION_REQUIRED', 'Send the If-Match header with the current version of the object (its ETag).');
  return raw.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

function checkVersion(req, current) {
  const expected = expectedVersion(req);
  if (expected !== String(current)) {
    throw fail(412, 'VERSION_MISMATCH', 'The object has changed since you read it. Read it again and repeat the change.',
      { details: { current_version: current } });
  }
}

function notFound(req, res) {
  return send(req, res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false } });
}

// В журнал ошибок не должны попасть номера телефонов (их приносит, например, текст нарушения UNIQUE у Postgres)
// и токены: длинные цифры и строки с префиксами токенов заменяем.
function redact(text) {
  return String(text).replace(/\+?\d[\d\s-]{7,}\d/g, '[number]').replace(/\bx(?:at|rt|ac)_[A-Za-z0-9_-]+/g, '[token]');
}

// Обработчик ошибок роутера API: ApiError — как есть; неверный JSON — 400; остальное — 500 без подробностей наружу.
function errorHandler(err, req, res, next) {
  if (!req.requestId) {
    req.requestId = 'req_' + randomBytes(9).toString('base64url');
    res.set('X-Request-Id', req.requestId);
    res.set('X-Xtender-Environment', apiConfig.environment());
  }
  if (err instanceof ApiError) {
    if (err.headers) res.set(err.headers);
    return send(req, res, err.status, { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}),
      retryable: err.retryable }, ...(err.details || {}) });
  }
  if (err && err.type === 'entity.parse.failed') {
    return send(req, res, 400, { error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.', retryable: false } });
  }
  console.error(`[api] ${req.requestId} failed:`, redact(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)));
  return send(req, res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', retryable: false } });
}

module.exports = {
  ApiError, fail, requestId, send, publicCache, authenticate, requireScope, requireActiveAccount, setVersion, expectedVersion,
  checkVersion, notFound, errorHandler, challenge, unauthorized, protectedResourceMetadataUrl, redact,
};
