// Сервер авторизации OAuth 2.1 для API v1 и будущего MCP-адаптера: Authorization Code + PKCE (S256), публичные
// клиенты без секрета, регистрация клиентов по RFC 7591, короткие access-токены и refresh-токены с ротацией,
// отзыв по RFC 7009. Вход — номер телефона и код из SMS на странице /oauth/authorize (oauth.controller).
// Токены и коды хранятся только хешами. Описание и проверка совместимости с ChatGPT — docs/api-v1/AUTH.md.
const crypto = require('node:crypto');
const pool = require('../config/db');
const apiConfig = require('../config/apiV1');

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hexId = (prefix) => prefix + crypto.randomBytes(10).toString('hex');

class OAuthError extends Error {
  constructor(error, description, status = 400) { super(description); Object.assign(this, { error, status }); }
}

// --- Адреса возврата ---------------------------------------------------------------------------------------
// Клиент регистрируется сам, поэтому принимаем только известные адреса возврата: ChatGPT (оба вида из
// developers.openai.com/plugins/build/auth) и Claude. OAUTH_REDIRECT_ALLOWLIST добавляет свои шаблоны через запятую,
// «*» — один сегмент из букв, цифр, «-», «_», «.». Адреса на своём компьютере (127.0.0.1, localhost) —
// только в песочнице и при локальной разработке, для тестовых клиентов.
const DEFAULT_REDIRECTS = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector/oauth/*',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function redirectPatterns() {
  const extra = String(process.env.OAUTH_REDIRECT_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_REDIRECTS, ...extra].map((pattern) => new RegExp('^' + pattern.split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9._-]+') + '$'));
}

function loopbackAllowed() {
  return apiConfig.isSandbox() || process.env.NODE_ENV === 'development' || process.env.OAUTH_ALLOW_LOOPBACK === '1';
}

function redirectAllowed(uri) {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let url;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return loopbackAllowed();
  if (url.protocol !== 'https:') return false;
  return redirectPatterns().some((pattern) => pattern.test(uri));
}

// --- Клиенты -------------------------------------------------------------------------------------------------
function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '';
}

function parseScope(value, allowed = apiConfig.SCOPE_NAMES) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') return null;
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  return scopes.every((scope) => allowed.includes(scope)) ? scopes : null;
}

async function registerClient(body = {}) {
  const fail = (description) => new OAuthError('invalid_client_metadata', description);
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5) throw new OAuthError('invalid_redirect_uri', 'redirect_uris: from 1 to 5 addresses.');
  const bad = uris.find((uri) => !redirectAllowed(uri));
  if (bad !== undefined) throw new OAuthError('invalid_redirect_uri', 'This redirect URI is not allowed on xtender.ge: ' + String(bad).slice(0, 200));
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    throw fail('Only public clients with PKCE are supported: token_endpoint_auth_method must be "none".');
  }
  const grantTypes = body.grant_types === undefined ? ['authorization_code', 'refresh_token'] : body.grant_types;
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    throw fail('grant_types: authorization_code and optionally refresh_token.');
  }
  const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') throw fail('response_types: only "code".');
  const scopes = parseScope(body.scope);
  if (scopes === null) throw fail('scope: unknown scope. Supported: ' + apiConfig.SCOPE_NAMES.join(' '));
  let clientUri = null;
  if (body.client_uri !== undefined) {
    try { const url = new URL(String(body.client_uri)); if (url.protocol !== 'https:') throw new Error(); clientUri = url.toString().slice(0, 300); } catch { throw fail('client_uri must be an https address.'); }
  }
  const client = {
    client_id: 'xtc_' + random(18),
    client_name: cleanText(body.client_name, 120) || 'Unnamed app',
    redirect_uris: [...new Set(uris)],
    scope: (scopes.length ? scopes : apiConfig.SCOPE_NAMES).join(' '),
    client_uri: clientUri,
  };
  const row = (await pool.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scope, client_uri) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING created_at`,
    [client.client_id, client.client_name, JSON.stringify(client.redirect_uris), client.scope, client.client_uri])).rows[0];
  return {
    ...client, client_uri: client.client_uri || undefined,
    client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
    grant_types: grantTypes, response_types: ['code'], token_endpoint_auth_method: 'none',
  };
}

async function getClient(clientId) {
  if (typeof clientId !== 'string' || clientId.length > 64) return null;
  const row = (await pool.query('SELECT * FROM oauth_clients WHERE client_id=$1', [clientId])).rows[0];
  return row && !row.disabled_at ? row : null;
}

// --- Запрос авторизации --------------------------------------------------------------------------------------
// Возвращает { request } или { error, description, redirect }: redirect=false — клиент или адрес возврата не
// подтверждены, ошибку показываем на странице и никуда не отправляем (RFC 6749, 4.1.2.1).
async function validateAuthorizationRequest(query = {}) {
  const client = await getClient(query.client_id);
  if (!client) return { error: 'invalid_client', description: 'Unknown client_id.', redirect: false };
  const redirectUri = query.redirect_uri;
  if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri) || !redirectAllowed(redirectUri)) {
    return { error: 'invalid_request', description: 'redirect_uri is missing or not registered for this client.', redirect: false };
  }
  const state = typeof query.state === 'string' ? query.state.slice(0, 500) : undefined;
  const back = (error, description) => ({ error, description, redirect: true, redirectUri, state });
  if (query.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
  if (typeof query.code_challenge !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(query.code_challenge)) return back('invalid_request', 'PKCE code_challenge is required.');
  if (query.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256.');
  const active = apiConfig.activeScopes();
  const scopes = parseScope(query.scope, client.scope.split(' ').filter((scope) => active.includes(scope)));
  if (scopes === null) return back('invalid_scope', 'Requested scope is unknown, not available yet or not allowed for this client. Available: ' + active.join(' '));
  const resource = query.resource === undefined || query.resource === '' ? apiConfig.resources().api : query.resource;
  if (typeof resource !== 'string' || !apiConfig.isResource(resource)) return back('invalid_target', 'Unknown resource.');
  return { request: {
    client_id: client.client_id, client_name: client.client_name, redirect_uri: redirectUri, state,
    code_challenge: query.code_challenge, scope: (scopes.length ? scopes : [apiConfig.DEFAULT_SCOPE]).join(' '), resource,
  } };
}

// Адрес возврата с параметрами ответа. iss — всегда (RFC 9207): ChatGPT отклоняет ответ без него.
function redirectWith(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: require('../config/url').getBaseUrl() })) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

// Человек вошёл и разрешил доступ: новая сессия и одноразовый код на две минуты.
async function approve(request, accountId) {
  const grantId = hexId('grt_');
  const code = random(32);
  await pool.withTransaction(async (client) => {
    await client.query('INSERT INTO oauth_grants (id, account_id, client_id, scope, resource) VALUES ($1,$2,$3,$4,$5)',
      [grantId, accountId, request.client_id, request.scope, request.resource]);
    await client.query(
      'INSERT INTO oauth_authorization_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [sha256(code), grantId, request.redirect_uri, request.code_challenge, new Date(Date.now() + apiConfig.AUTHORIZATION_CODE_TTL_SECONDS * 1000)]);
  });
  return code;
}

// --- Токены --------------------------------------------------------------------------------------------------
async function issueTokens(grant, client = pool) {
  const access = 'xat_' + random(32);
  const refresh = 'xrt_' + random(32);
  const now = Date.now();
  await client.query('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1,$2,$3,$4)',
    [sha256(access), grant.id, 'access', new Date(now + apiConfig.ACCESS_TOKEN_TTL_SECONDS * 1000)]);
  await client.query('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1,$2,$3,$4)',
    [sha256(refresh), grant.id, 'refresh', new Date(now + apiConfig.REFRESH_TOKEN_TTL_SECONDS * 1000)]);
  return { access_token: access, token_type: 'Bearer', expires_in: apiConfig.ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: grant.scope };
}

async function revokeGrant(grantId, reason) {
  await pool.query('UPDATE oauth_grants SET revoked_at = NOW(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [grantId, reason]);
}

function verifierMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return computed.length === challenge.length && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

async function grantById(id, client = pool) {
  return (await client.query('SELECT * FROM oauth_grants WHERE id=$1', [id])).rows[0] || null;
}

async function exchangeCode({ code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }) {
  if (typeof code !== 'string' || code.length > 100) throw new OAuthError('invalid_request', 'code is required.');
  const row = (await pool.query('SELECT * FROM oauth_authorization_codes WHERE code_hash=$1', [sha256(code)])).rows[0];
  if (!row) throw new OAuthError('invalid_grant', 'The authorization code is invalid.');
  const grant = await grantById(row.grant_id);
  // Повторное предъявление кода — признак перехвата: гасим всё, что по нему выдано. Тот же случай — два обмена
  // одновременно: второй не находит свободного кода в транзакции ниже и тоже отключает сессию.
  if (row.used_at) { if (grant) await revokeGrant(grant.id, 'code_reuse'); throw new OAuthError('invalid_grant', 'The authorization code was already used.'); }
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('invalid_grant', 'The authorization code has expired.');
  if (!grant || grant.revoked_at) throw new OAuthError('invalid_grant', 'The authorization was revoked.');
  if (grant.client_id !== clientId) throw new OAuthError('invalid_grant', 'The code was issued to another client.');
  if (redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
  if (!verifierMatches(verifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
  if (resource !== undefined && resource !== '' && resource !== grant.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request.');
  if (!await getClient(clientId)) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
  const tokens = await pool.withTransaction(async (client) => {
    const used = await client.query('UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code_hash = $1 AND used_at IS NULL RETURNING code_hash', [row.code_hash]);
    return used.rows[0] ? issueTokens(grant, client) : null;
  });
  if (!tokens) { await revokeGrant(grant.id, 'code_reuse'); throw new OAuthError('invalid_grant', 'The authorization code was already used.'); }
  return tokens;
}

async function refresh({ refresh_token: token, client_id: clientId, scope, resource }) {
  if (typeof token !== 'string' || !token.startsWith('xrt_') || token.length > 100) throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
  const row = (await pool.query("SELECT * FROM oauth_tokens WHERE token_hash=$1 AND kind='refresh'", [sha256(token)])).rows[0];
  if (!row) throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
  const grant = await grantById(row.grant_id);
  if (!grant || grant.client_id !== clientId) throw new OAuthError('invalid_grant', 'The refresh token was issued to another client.');
  if (grant.revoked_at) throw new OAuthError('invalid_grant', 'The session was disconnected.');
  // Уже обменянный refresh-токен предъявлен снова: его украли или клиент сбился — отключаем сессию.
  if (row.used_at) { await revokeGrant(grant.id, 'refresh_reuse'); throw new OAuthError('invalid_grant', 'The refresh token was already used; the session is disconnected.'); }
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('invalid_grant', 'The refresh token has expired.');
  if (scope !== undefined && scope !== '' && parseScope(scope, grant.scope.split(' ')) === null) throw new OAuthError('invalid_scope', 'scope is wider than the granted one.');
  if (resource !== undefined && resource !== '' && resource !== grant.resource) throw new OAuthError('invalid_target', 'resource does not match the session.');
  if (!await getClient(clientId)) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
  const tokens = await pool.withTransaction(async (client) => {
    const used = await client.query('UPDATE oauth_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL RETURNING token_hash', [row.token_hash]);
    return used.rows[0] ? issueTokens(grant, client) : null;
  });
  if (!tokens) { await revokeGrant(grant.id, 'refresh_reuse'); throw new OAuthError('invalid_grant', 'The refresh token was already used; the session is disconnected.'); }
  return tokens;
}

// Токен из заголовка Authorization: действующий access-токен, сессия не отозвана, клиент не отключён,
// ресурс — этот сервис. Возвращает аккаунт, сессию и области доступа; иначе null.
async function verifyAccessToken(token) {
  if (typeof token !== 'string' || !token.startsWith('xat_')) return null;
  const row = (await pool.query(
    `SELECT t.expires_at AS token_expires_at, g.id AS grant_id, g.client_id, g.scope, g.resource, g.created_at AS grant_created_at,
            g.revoked_at, g.last_used_at, c.client_name, c.disabled_at
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.client_id = g.client_id
     WHERE t.token_hash = $1 AND t.kind = 'access'`, [sha256(token)])).rows[0];
  if (!row || row.revoked_at || row.disabled_at || new Date(row.token_expires_at).getTime() < Date.now() || !apiConfig.isResource(row.resource)) return null;
  const grant = await grantById(row.grant_id);
  const account = await require('./account.service').getById(grant.account_id);
  if (!account) return null;
  const minuteAgo = new Date(Date.now() - 60 * 1000);
  if (!row.last_used_at || new Date(row.last_used_at) < minuteAgo) {
    await pool.query('UPDATE oauth_grants SET last_used_at = NOW() WHERE id = $1', [row.grant_id]).catch(() => {});
  }
  return {
    account,
    grant: { id: row.grant_id, client_id: row.client_id, client_name: row.client_name, scope: row.scope, resource: row.resource, created_at: row.grant_created_at },
    scopes: new Set(row.scope.split(' ')),
  };
}

// RFC 7009: отзыв любого токена отключает всю сессию. Ответ всегда успешный, даже для неизвестного токена.
async function revokeToken({ token, client_id: clientId }) {
  if (typeof token !== 'string' || token.length > 100) return;
  const row = (await pool.query('SELECT grant_id FROM oauth_tokens WHERE token_hash=$1', [sha256(token)])).rows[0];
  if (!row) return;
  const grant = await grantById(row.grant_id);
  if (grant && (!clientId || clientId === grant.client_id)) await revokeGrant(grant.id, 'client_revoked');
}

async function listSessions(accountId) {
  return (await pool.query(
    `SELECT g.id, g.client_id, c.client_name, g.scope, g.created_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
     WHERE g.account_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC, g.id`, [accountId])).rows;
}

async function revokeSession(accountId, grantId) {
  const { rows } = await pool.query(
    "UPDATE oauth_grants SET revoked_at = NOW(), revoke_reason = 'user_revoked' WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING id",
    [grantId, accountId]);
  return Boolean(rows[0]);
}

// Просроченные коды и токены больше не нужны: сессия и её отзыв остаются в oauth_grants.
async function cleanup() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await pool.query('DELETE FROM oauth_tokens WHERE expires_at < $1', [dayAgo]);
  await pool.query('DELETE FROM oauth_authorization_codes WHERE expires_at < $1', [dayAgo]);
}

function start() {
  const run = () => cleanup().catch((err) => console.error('[oauth] cleanup failed:', err.message));
  setTimeout(run, 90 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = {
  OAuthError, DEFAULT_REDIRECTS, redirectAllowed, parseScope, registerClient, getClient, validateAuthorizationRequest, redirectWith,
  approve, exchangeCode, refresh, verifyAccessToken, revokeToken, listSessions, revokeSession, revokeGrant, cleanup, start, sha256,
};
