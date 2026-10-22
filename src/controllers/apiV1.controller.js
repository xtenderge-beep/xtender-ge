// Обработчики API v1, этап 1 ТЗ: возможности сервиса, аккаунт, профиль исполнителя, подключённые приложения,
// каталог категорий, схема категории, география, единицы. Описание контракта — docs/api-v1/openapi.yaml,
// поведение — docs/api-v1/README.md. Права: роль считается на сервере, область доступа — по токену,
// объект — только свой (чужой id в запросе ничего не даёт: аккаунт берётся из токена).
const api = require('../middleware/apiV1');
const apiConfig = require('../config/apiV1');
const catalog = require('../services/apiCatalog.service');
const accountService = require('../services/account.service');
const oauthService = require('../services/oauth.service');
const providerProfile = require('../services/providerProfileApi.service');
const units = require('../config/units');
const { ACTIONS, SERVICE_DESCRIPTION } = require('../config/apiCapabilities');
const { localizedPath } = require('../config/seo');
const { getBaseUrl } = require('../config/url');
const phoneInText = require('../config/phoneInText');
const redis = require('../config/redis');

const { send, fail } = api;
const LANGS = ['ka', 'ru', 'en'];

// Язык ответа: ?lang, иначе язык аккаунта, иначе английский (по-английски модель понимает любой ответ).
function langOf(req) {
  const asked = req.query.lang;
  if (asked !== undefined) {
    if (!LANGS.includes(asked)) throw fail(422, 'VALIDATION_FAILED', 'lang must be ka, ru or en.', { fields: [{ path: 'lang', code: 'INVALID_VALUE' }] });
    return asked;
  }
  return req.auth?.account?.locale || 'en';
}

// --- Пагинация -----------------------------------------------------------------------------------------------------
// Курсор — непрозрачная строка: смещение, версия данных и отпечаток фильтров. Сменилась версия каталога — 409:
// продолжать по старому курсору значило бы смешать два разных списка.
function pageParams(req) {
  const raw = req.query.limit;
  const limit = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(422, 'VALIDATION_FAILED', 'limit must be an integer from 1 to 100.', { fields: [{ path: 'limit', code: 'OUT_OF_RANGE' }] });
  return { limit, cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null };
}

function paginate(items, { limit, cursor }, { version, filters }) {
  const fingerprint = catalog.hash(filters);
  let offset = 0;
  if (cursor) {
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { parsed = null; }
    if (!parsed || !Number.isInteger(parsed.o) || parsed.o < 0 || parsed.f !== fingerprint) throw fail(400, 'INVALID_CURSOR', 'The cursor does not belong to this query. Start again without cursor.');
    if (parsed.v !== version) throw fail(409, 'SNAPSHOT_CHANGED', 'The data changed while you were paging. Start again without cursor.', { details: { current_version: version } });
    offset = parsed.o;
  }
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { page, has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ o: offset + limit, v: version, f: fingerprint })).toString('base64url') : null, total: items.length };
}

// --- Возможности ---------------------------------------------------------------------------------------------------
function actionView(action, auth, roles) {
  const supported = Boolean(action.implemented);
  let available = null;
  let reason = supported ? null : 'not_implemented';
  if (auth) {
    const missingRole = action.roles.length && !action.roles.some((role) => roles.includes(role));
    const missingScope = action.scopes.find((scope) => !auth.scopes.has(scope));
    const writes = (action.side_effects || []).length > 0;
    if (!supported) available = false;
    else if (missingRole) { available = false; reason = 'role_required:' + action.roles.join('|'); }
    else if (missingScope) { available = false; reason = 'scope_required:' + missingScope; }
    else if (writes && auth.account.status !== 'active') { available = false; reason = 'account_read_only'; }
    else available = true;
  }
  return {
    id: action.id, description: action.description, operation_id: action.operation_id, stage: action.stage, supported,
    available_to_user: available, unavailable_reason: available === true ? null : reason,
    required_roles: action.roles, required_scopes: action.scopes, requires_confirmation: Boolean(action.confirm),
    side_effects: action.side_effects || [],
  };
}

async function capabilities(req, res) {
  const lang = langOf(req);
  const snap = await catalog.snapshot();
  const roles = req.auth ? (await accountService.roles(req.auth.account)).roles : [];
  const served = (await catalog.locations({ lang })).filter((item) => item.type === 'city' && item.served);
  const base = getBaseUrl();
  return send(req, res, 200, {
    api_version: apiConfig.API_VERSION,
    capabilities_version: 'cap_' + catalog.hash(ACTIONS),
    catalog_version: snap.version,
    updated_at: snap.updatedAt,
    environment: apiConfig.environment(),
    language: lang,
    service_description: SERVICE_DESCRIPTION[lang],
    supported_languages: LANGS,
    supported_currencies: ['GEL'],
    coverage_summary: {
      country_code: 'GE',
      served_cities: served.map(({ id, name }) => ({ id, name })),
      locations_operation_id: 'listLocations',
      note: 'A served city means Xtender accepts requests there; it does not promise that a provider is free or will answer.',
    },
    authenticated: Boolean(req.auth),
    account_roles: req.auth ? roles : null,
    actions: ACTIONS.map((action) => actionView(action, req.auth, roles)),
    category_search: {
      operation_id: 'searchCategories', supports_q: true, q_max_length: catalog.Q_MAX_LENGTH, languages: LANGS,
      georgian_in_latin_letters: true, location_filter: true, kinds: ['service'], semantic_search: false,
      note: 'Matching is by words and their beginnings, with Georgian, Russian and Latin spellings folded together. match_rank is an order, not a probability.',
    },
    constraints: {
      pagination: { default_limit: 20, max_limit: 100 },
      rate_limit_per_minute_per_session: apiConfig.RATE_LIMIT_PER_MINUTE,
      phone_numbers: 'Georgian mobile numbers (+995) only',
      attachments: { supported: false },
      money: { unit: 'minor (tetri): 20000 = 200.00 GEL' },
    },
    notification_channels: [
      { channel: 'sms', supported: false, requires_verified_contact: true, requires_consent: true, note: 'SMS rules for API requests are planned (stage 3).' },
    ],
    auth: {
      type: 'oauth2_authorization_code_pkce',
      authorization_server_metadata: base + '/.well-known/oauth-authorization-server',
      protected_resource_metadata: api.protectedResourceMetadataUrl(),
      scopes: apiConfig.activeScopes(), planned_scopes: apiConfig.SCOPE_NAMES.filter((scope) => !apiConfig.activeScopes().includes(scope)),
    },
    existing_integrations: {
      mcp_endpoint: { url: base + '/mcp', authenticated: false, tools: ['list_services', 'create_request_link'] },
      request_link: base + '/draft',
      llms_txt: base + '/llms.txt',
    },
  });
}

// --- Аккаунт ---------------------------------------------------------------------------------------------------------
async function meView(auth) {
  const { account } = auth;
  const { roles, providerStatus } = await accountService.roles(account);
  return {
    id: account.id,
    display_name: account.display_name,
    roles,
    locale: account.locale,
    timezone: account.timezone,
    phone_verified: Boolean(account.phone_verified_at),
    masked_phone: accountService.maskedPhone(account.phone),
    account_status: account.status,
    provider: providerStatus ? { status: providerStatus, profile_operation_id: 'getProviderProfile' } : null,
    available_actions: ACTIONS.map((action) => actionView(action, auth, roles)).filter((a) => a.available_to_user).map((a) => a.id),
    usage_limits: { rate_limit_per_minute: apiConfig.RATE_LIMIT_PER_MINUTE },
    session: { id: auth.grant.id, client_name: auth.grant.client_name, scopes: [...auth.scopes] },
    environment: apiConfig.environment(),
    version: account.version,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

async function getMe(req, res) {
  api.setVersion(res, req.auth.account.version);
  return send(req, res, 200, await meView(req.auth));
}

function validTimezone(value) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

async function updateMe(req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw fail(400, 'INVALID_REQUEST', 'Send a JSON object.');
  api.checkVersion(req, req.auth.account.version);
  const fields = [];
  const changes = {};
  for (const key of Object.keys(body)) {
    if (!['display_name', 'locale', 'timezone'].includes(key)) fields.push({ path: key, code: 'FIELD_NOT_WRITABLE' });
  }
  if (body.display_name !== undefined) {
    const name = body.display_name === null ? null : typeof body.display_name === 'string' ? body.display_name.replace(/[\u0000-\u001f<>]/g, '').trim() : undefined;
    if (name === undefined || (name !== null && (!name || name.length > 80))) fields.push({ path: 'display_name', code: 'INVALID_VALUE' });
    else if (name && phoneInText.hasPhone(name)) fields.push({ path: 'display_name', code: 'CONTAINS_PHONE' });
    else changes.display_name = name;
  }
  if (body.locale !== undefined) {
    if (!LANGS.includes(body.locale)) fields.push({ path: 'locale', code: 'INVALID_VALUE' });
    else changes.locale = body.locale;
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || body.timezone.length > 64 || !validTimezone(body.timezone)) fields.push({ path: 'timezone', code: 'INVALID_VALUE' });
    else changes.timezone = body.timezone;
  }
  if (fields.length) throw fail(422, 'VALIDATION_FAILED', 'Some fields cannot be changed or have invalid values.', { fields });
  let account = req.auth.account;
  if (Object.keys(changes).length) {
    account = await accountService.update(account.id, account.version, changes);
    if (!account) {
      const fresh = await accountService.getById(req.auth.account.id);
      throw fail(412, 'VERSION_MISMATCH', 'The account has changed since you read it. Read it again and repeat the change.', { details: { current_version: fresh?.version ?? null } });
    }
  }
  api.setVersion(res, account.version);
  return send(req, res, 200, await meView({ ...req.auth, account }));
}

// --- Профиль исполнителя -------------------------------------------------------------------------------------------
function registrationUrl(lang) { return getBaseUrl() + localizedPath(lang, '/join'); }

async function getProviderProfile(req, res) {
  const lang = langOf(req);
  const { master } = await accountService.roles(req.auth.account);
  if (!master) throw fail(404, 'PROVIDER_PROFILE_NOT_FOUND', 'This account has no provider profile. Providers register on the site (consent and SMS code are required there).', { details: { registration_url: registrationUrl(lang) } });
  const profile = await providerProfile.get(req.auth.account, master.id, lang);
  api.setVersion(res, profile.version);
  return send(req, res, 200, profile);
}

async function updateProviderProfile(req, res) {
  const lang = langOf(req);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw fail(400, 'INVALID_REQUEST', 'Send a JSON object.');
  const { master } = await accountService.roles(req.auth.account);
  if (!master) {
    throw fail(409, 'PROVIDER_REGISTRATION_REQUIRED', 'This account has no provider profile. Registration is done on the site, where the person accepts the terms and confirms the phone; the API does not register providers.',
      { details: { registration_url: registrationUrl(lang) } });
  }
  const expected = api.expectedVersion(req);
  const result = await providerProfile.update(req.auth.account, master.id, expected, body, lang);
  if (result.status === 'blocked') throw fail(403, 'PROVIDER_BLOCKED', 'This provider profile is blocked; changes are not allowed.');
  if (result.status === 'missing') throw fail(404, 'PROVIDER_PROFILE_NOT_FOUND', 'This account has no provider profile.');
  if (result.status === 'conflict') throw fail(412, 'VERSION_MISMATCH', 'The profile has changed since you read it. Read it again and repeat the change.', { details: { current_version: result.current } });
  if (result.status === 'invalid') {
    throw fail(422, 'VALIDATION_FAILED', 'Only languages and availability_status can be changed through the API; services, cities, description and name are changed by Xtender moderators.', { fields: result.fields });
  }
  api.setVersion(res, result.profile.version);
  return send(req, res, 200, result.profile);
}

// --- Подключённые приложения ---------------------------------------------------------------------------------------
async function listSessions(req, res) {
  const sessions = await oauthService.listSessions(req.auth.account.id);
  return send(req, res, 200, { items: sessions.map((s) => ({
    id: s.id, client_id: s.client_id, client_name: s.client_name, scopes: s.scope.split(' '), created_at: s.created_at,
    last_used_at: s.last_used_at, current: s.id === req.auth.grant.id })), has_more: false, next_cursor: null });
}

async function revokeSession(req, res) {
  if (typeof req.params.id !== 'string' || !/^grt_[a-f0-9]{20}$/.test(req.params.id) || !await oauthService.revokeSession(req.auth.account.id, req.params.id)) {
    throw fail(404, 'NOT_FOUND', 'Session not found.');
  }
  return send(req, res, 200, { id: req.params.id, revoked: true });
}

// --- Каталог -------------------------------------------------------------------------------------------------------
async function locationParam(req) {
  if (req.query.location_id === undefined) return null;
  const location = await catalog.resolveLocation(req.query.location_id);
  if (!location) throw fail(422, 'VALIDATION_FAILED', 'Unknown location_id; see listLocations.', { fields: [{ path: 'location_id', code: 'UNKNOWN_LOCATION' }] });
  return location;
}

function boolParam(req, name, fallback) {
  const value = req.query[name];
  if (value === undefined) return fallback;
  if (value === 'true' || value === 'false') return value === 'true';
  throw fail(422, 'VALIDATION_FAILED', `${name} must be true or false.`, { fields: [{ path: name, code: 'INVALID_VALUE' }] });
}

async function searchCategories(req, res) {
  const lang = langOf(req);
  const q = req.query.q === undefined ? '' : String(req.query.q);
  if (q.length > catalog.Q_MAX_LENGTH) throw fail(422, 'VALIDATION_FAILED', `q is longer than ${catalog.Q_MAX_LENGTH} characters.`, { fields: [{ path: 'q', code: 'TOO_LONG' }] });
  const kind = req.query.kind;
  if (kind !== undefined && !['service', 'goods'].includes(kind)) throw fail(422, 'VALIDATION_FAILED', 'kind must be service or goods.', { fields: [{ path: 'kind', code: 'INVALID_VALUE' }] });
  const activeOnly = boolParam(req, 'active_only', true);
  const location = await locationParam(req);
  const paging = pageParams(req);
  const { snapshot, items, matchStatus } = await catalog.searchCategories({ q: q.trim(), lang, kind, location, activeOnly });
  const page = paginate(items, paging, { version: snapshot.version, filters: { q: q.trim(), lang, kind, location: location?.id, activeOnly } });
  if (!req.auth) api.publicCache(res, 60);
  return send(req, res, 200, {
    items: page.page, match_status: matchStatus, query: q.trim() || null, language: lang,
    catalog_version: snapshot.version, catalog_updated_at: snapshot.updatedAt, total: page.total,
    next_cursor: page.next_cursor, has_more: page.has_more,
  });
}

async function getCategorySchema(req, res) {
  const lang = langOf(req);
  const result = await catalog.getSchema(String(req.params.id), lang);
  if (!result) throw fail(404, 'CATEGORY_NOT_FOUND', 'Unknown category id; see searchCategories.');
  if (!req.auth) api.publicCache(res, 60);
  api.setVersion(res, result.body.schema_version);
  return send(req, res, 200, { ...result.body, language: lang });
}

async function listLocations(req, res) {
  const lang = langOf(req);
  const q = req.query.q === undefined ? '' : String(req.query.q);
  if (q.length > 100) throw fail(422, 'VALIDATION_FAILED', 'q is longer than 100 characters.', { fields: [{ path: 'q', code: 'TOO_LONG' }] });
  const parentId = req.query.parent_id === undefined ? null : String(req.query.parent_id);
  const paging = pageParams(req);
  const items = await catalog.locations({ q: q.trim(), parentId, lang });
  const version = 'loc_' + catalog.hash(items.map(({ id, served, names }) => [id, served, names]));
  const page = paginate(items, paging, { version, filters: { q: q.trim(), parentId, lang } });
  if (!req.auth) api.publicCache(res, 60);
  return send(req, res, 200, { items: page.page, language: lang, next_cursor: page.next_cursor, has_more: page.has_more });
}

async function listUnits(req, res) {
  const lang = langOf(req);
  if (!req.auth) api.publicCache(res, 300);
  return send(req, res, 200, { items: units.list(lang), language: lang, next_cursor: null, has_more: false });
}

// --- Песочница: SMS, которые «ушли» бы на этот номер ------------------------------------------------------------------
async function sandboxSms(req, res) {
  if (!apiConfig.isSandbox()) return api.notFound(req, res);
  const phone = typeof req.query.phone === 'string' ? require('../config/phone').toE164(req.query.phone) : null;
  const raw = await redis.lrange('sandbox:sms', 0, 199);
  const items = raw.map((line) => JSON.parse(line)).filter((sms) => !phone || sms.to === phone);
  return send(req, res, 200, { items, has_more: false, next_cursor: null });
}

module.exports = {
  capabilities, getMe, updateMe, getProviderProfile, updateProviderProfile, listSessions, revokeSession,
  searchCategories, getCategorySchema, listLocations, listUnits, sandboxSms, langOf, paginate,
};
