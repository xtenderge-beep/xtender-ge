// Профиль исполнителя для API v1 (GET/PUT /api/v1/me/provider-profile) поверх существующих таблиц: masters,
// master_services, master_cities, master_reviews. Своей таблицы нет. Правка — только то, что исполнитель и сейчас
// меняет сам в кабинете: языки общения и приём новых заявок. Услуги, характеристики, города, описание и имя влияют
// на рассылку и каталог — их по-прежнему меняет модератор (решение владельца 2026-09-01, память «provider cabinet»).
// Профиля нет — регистрация только на /join: там две галочки согласия и код из SMS, через API её не повторяем.
const pool = require('../config/db');
const categoryService = require('./category.service');
const masterAudit = require('./masterAudit.service');
const leadSubscription = require('./leadSubscription.service');
const spokenLanguages = require('../config/spokenLanguages');
const { descriptionFor } = require('./master.service');
const { resolve: displayName } = require('../config/providerName');
const { hash } = require('./apiCatalog.service');

const EDITABLE = ['languages', 'availability_status'];
const MODERATED = ['category_ids', 'services', 'service_area_ids', 'description', 'display_name'];
// Поля, которые сервер считает сам: их можно прислать обратно как есть (PUT целого объекта), они не меняются.
const COMPUTED = ['user_id', 'provider_id', 'status', 'verification_status', 'rating', 'review_count', 'rating_source',
  'notification_preferences', 'billing_mode', 'editable_fields', 'moderated_fields', 'version', 'created_at', 'updated_at', 'registration_url', 'request_id'];

async function load(masterId, client = pool) {
  const master = (await client.query(
    `SELECT id, name, display_name_override, is_active, is_banned, is_subscribed, spoken_languages, description, description_source_lang,
            description_translations, telegram_linked_at, paid_mode, city_id, created_at
     FROM masters WHERE id = $1`, [masterId])).rows[0];
  if (!master) return null;
  const services = (await client.query('SELECT service_type, attributes, is_primary FROM master_services WHERE master_id = $1 ORDER BY service_type', [masterId])).rows;
  const cities = (await client.query('SELECT c.slug, c.sort_order FROM master_cities mc JOIN cities c ON c.id = mc.city_id WHERE mc.master_id = $1', [masterId])).rows
    .sort((a, b) => a.sort_order - b.sort_order || (a.slug < b.slug ? -1 : 1));
  // Старые профили без списка городов работают в городе из masters.city_id, а без него — в Тбилиси (как в каталоге).
  if (!cities.length) {
    const legacy = master.city_id
      ? (await client.query('SELECT slug FROM cities WHERE id = $1', [master.city_id])).rows[0]
      : (await client.query("SELECT slug FROM cities WHERE slug = 'tbilisi'")).rows[0];
    if (legacy) cities.push(legacy);
  }
  const reviews = (await client.query('SELECT rating FROM master_reviews WHERE master_id = $1 AND is_approved = true', [masterId])).rows;
  return { master, services, cities, reviews };
}

// Версия — от данных профиля, а не от счётчика: профиль правят и админка, и кабинет, и API, счётчик разошёлся бы.
function versionOf({ master, services, cities }) {
  return 'pv_' + hash({
    name: master.name, override: master.display_name_override, active: master.is_active, banned: master.is_banned,
    subscribed: master.is_subscribed, languages: master.spoken_languages, description: master.description,
    services: services.map((s) => [s.service_type, s.attributes, s.is_primary]), cities: cities.map((c) => c.slug),
  });
}

function view(data, account, lang, categories) {
  const { master, services, cities, reviews } = data;
  const active = new Map(categories.map((c) => [c.slug, c]));
  const status = master.is_banned ? 'banned' : master.is_active ? 'active' : 'pending';
  const text = descriptionFor(master, lang);
  const ratings = reviews.map((r) => Number(r.rating)).filter(Number.isFinite);
  return {
    user_id: account.id,
    provider_id: 'prv_' + master.id,
    status,
    display_name: displayName(master),
    category_ids: services.filter((s) => active.get(s.service_type)?.is_active).map((s) => s.service_type),
    services: services.map((s) => ({ category_id: s.service_type, active: Boolean(active.get(s.service_type)?.is_active), is_primary: s.is_primary, attributes: s.attributes || {} })),
    service_area_ids: cities.map((c) => 'city:' + c.slug),
    languages: Array.isArray(master.spoken_languages) ? master.spoken_languages : [],
    availability_status: master.is_subscribed ? 'available' : 'unsubscribed',
    description: master.description ? {
      text, language: text === master.description ? master.description_source_lang || null : lang,
      original_text: master.description, original_language: master.description_source_lang || null,
    } : null,
    // Канал уведомлений о заявках: привязанный Telegram, иначе SMS (так работает рассылка сейчас). Правится в кабинете.
    notification_preferences: { request_channel: master.telegram_linked_at ? 'telegram' : 'sms', sms_fallback: Boolean(master.telegram_linked_at), editable: false },
    rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null,
    review_count: ratings.length,
    rating_source: ratings.length ? 'xtender_moderated_reviews' : null,
    verification_status: master.is_banned ? 'blocked' : master.is_active ? 'approved_by_moderator' : 'pending_moderation',
    billing_mode: master.paid_mode ? 'paid' : 'free_period',
    editable_fields: EDITABLE,
    moderated_fields: MODERATED,
    version: versionOf(data),
    created_at: master.created_at,
  };
}

async function get(account, masterId, lang) {
  const data = await load(masterId);
  return data ? view(data, account, lang, await categoryService.list()) : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Проверка тела PUT. Возвращает { changes, fields } — fields для ответа 422.
function validate(body, current) {
  const fields = [];
  const changes = {};
  for (const key of Object.keys(body)) {
    if (EDITABLE.includes(key) || COMPUTED.includes(key)) continue;
    if (MODERATED.includes(key)) {
      const sent = key === 'description' && body[key] && typeof body[key] === 'object' ? body[key].original_text : body[key];
      const now = key === 'description' ? current.description?.original_text ?? null : current[key];
      if (!same(sent, now)) fields.push({ path: key, code: 'MODERATOR_ONLY' });
      continue;
    }
    fields.push({ path: key, code: 'UNKNOWN_FIELD' });
  }
  if (body.languages !== undefined) {
    const parsed = spokenLanguages.parse(body.languages);
    if (!parsed) fields.push({ path: 'languages', code: 'INVALID_VALUE', allowed: Object.keys(spokenLanguages.options) });
    else if (!same(parsed, current.languages)) changes.languages = parsed;
  }
  if (body.availability_status !== undefined) {
    if (!['available', 'unsubscribed'].includes(body.availability_status)) fields.push({ path: 'availability_status', code: 'INVALID_VALUE', allowed: ['available', 'unsubscribed'] });
    else if (body.availability_status !== current.availability_status) changes.availability_status = body.availability_status;
  }
  return { changes, fields };
}

// Правка с проверкой версии. Возвращает { status: 'ok' | 'conflict' | 'invalid' | 'blocked', profile, fields, current }.
async function update(account, masterId, expectedVersion, body, lang) {
  const categories = await categoryService.list();
  const outcome = await pool.withTransaction(async (client) => {
    await client.query('SELECT id FROM masters WHERE id = $1 FOR UPDATE', [masterId]);
    const data = await load(masterId, client);
    if (!data) return { status: 'missing' };
    const current = view(data, account, lang, categories);
    if (current.status === 'banned') return { status: 'blocked' };
    if (expectedVersion !== current.version) return { status: 'conflict', current: current.version };
    const { changes, fields } = validate(body, current);
    if (fields.length) return { status: 'invalid', fields };
    if (changes.languages) await client.query('UPDATE masters SET spoken_languages = $1::jsonb WHERE id = $2', [JSON.stringify(changes.languages), masterId]);
    return { status: 'ok', changes };
  });
  if (outcome.status !== 'ok') return outcome;
  const { changes } = outcome;
  if (changes.languages) {
    await masterAudit.record(masterId, { actor: 'Исполнитель', action: 'edit_languages',
      body: 'Языки общения: ' + changes.languages.map((code) => spokenLanguages.ruNames[code] || code).join(', ') + ' (API)' });
  }
  if (changes.availability_status) await leadSubscription.set(masterId, changes.availability_status === 'available', { source: 'api' });
  return { status: 'ok', profile: await get(account, masterId, lang) };
}

module.exports = { EDITABLE, MODERATED, get, update, validate, versionOf };
