const consentLog = require('./consentLog.service');
const settingsService = require('./settings.service');
const pool = require('../config/db');
const { generateShortId } = require('../config/shortId');
const { legacyColumnsFor } = require('../config/serviceTypes');

const FIELDS = 'is_technical, id, name, phone, category, vehicle_type, vehicle_size, price_text, description, avatar_url, rating, language';

// Регистрация с /join (Фаза 2 конфиг-движка). Пишет:
//   masters              — профиль + city_id + avatar_url + старые колонки в синхроне
//                          (category/vehicle_size/is_flatbed — пока их читают каталог/рассылка)
//   master_services      — одна строка типа услуги с attributes (JSONB)
//   master_districts     — районы, где исполнитель берёт заказы (полная замена)
// Всё в одной транзакции. ON CONFLICT (phone) — повторная регистрация обновляет профиль
// и строку услуги того же типа (is_active снова false → снова на модерацию).
async function registerMaster({
  name, phone, description, serviceType, attributes = {}, spokenLanguages = null,
  vehicleTypeText = null, cityId = null, districtIds = [], cityIds = null, photoUrl = null,
  consentGrant = null, requestMeta = {}, referralToken = null, referralPromoCode = null, language = null,
}) {
  const masterToken = generateShortId();
  const legacy = legacyColumnsFor(serviceType, attributes);
  const vehicleType = serviceType === 'van' ? (vehicleTypeText || null) : null;

  return pool.withTransaction(async (client) => {
    const welcomeBonusTetri = await settingsService.getWelcomeBonusTetri();
    const inserted = await client.query(`INSERT INTO masters (name, phone, description, category, vehicle_type, vehicle_size, is_flatbed,
                            city_id, avatar_url, is_active, balance_tetri, master_token, terms_accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $11, $10, NOW())
       ON CONFLICT (phone) DO NOTHING RETURNING *`,
      [name, phone, description || null, legacy.category, vehicleType, legacy.vehicle_size,
       legacy.is_flatbed, cityId || null, photoUrl || null, masterToken, welcomeBonusTetri]);
    let master = inserted.rows.find(row => row.master_token === masterToken);
    const isNew = Boolean(master);
    if (!master) {
    const { rows } = await client.query(
      `INSERT INTO masters (name, phone, description, category, vehicle_type, vehicle_size, is_flatbed,
                            city_id, avatar_url, is_active, balance_tetri, master_token, terms_accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 0, $10, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         vehicle_type = EXCLUDED.vehicle_type,
         vehicle_size = EXCLUDED.vehicle_size,
         is_flatbed = EXCLUDED.is_flatbed,
         city_id = EXCLUDED.city_id,
         avatar_url = COALESCE(EXCLUDED.avatar_url, masters.avatar_url),
         is_active = false,
         master_token = COALESCE(masters.master_token, EXCLUDED.master_token),
         terms_accepted_at = NOW()
       RETURNING *`,
      [name, phone, description || null, legacy.category, vehicleType, legacy.vehicle_size,
       legacy.is_flatbed, cityId || null, photoUrl || null, masterToken]
    );
    master = rows[0];
    }
    // Язык сайта на момент регистрации — источник правды для /master/:token (см.
    // schema.sql), а не кука `lang`: ссылка на кабинет приходит по SMS и часто
    // открывается на другом устройстве/браузере без неё. Обновляем и при повторной
    // регистрации тем же приёмом, что и остальной профиль (см. комментарий выше).
    if (language) {
      const normalized = require('../config/i18n').normalizeLang(language);
      // registration_language пишется один раз (см. schema.sql): повторная регистрация меняет только
      // `language`, а у аккаунта без записи заполняет пустое.
      await client.query('UPDATE masters SET language = $1, registration_language = COALESCE(registration_language, $3) WHERE id = $2', [normalized, master.id, normalized]);
      master.language = normalized;
      master.registration_language = master.registration_language || normalized;
    }
    if (spokenLanguages !== null) {
      const languages = require('../config/spokenLanguages').parse(spokenLanguages);
      if (!languages) throw new Error('Invalid spoken languages');
      await client.query('UPDATE masters SET spoken_languages = $1::jsonb WHERE id = $2', [JSON.stringify(languages), master.id]);
      master.spoken_languages = languages;
    }
    if (cityIds !== null) {
      const available = await client.query('SELECT id FROM cities');
      const valid = new Set(available.rows.map(c => c.id));
      if (!Array.isArray(cityIds) || !cityIds.length || cityIds.some(id => !Number.isSafeInteger(id) || !valid.has(id))) throw new Error('Invalid work cities');
      await client.query('DELETE FROM master_cities WHERE master_id = $1', [master.id]);
      for (const id of new Set(cityIds)) await client.query('INSERT INTO master_cities (master_id, city_id) VALUES ($1, $2)', [master.id, id]);
      await client.query('UPDATE masters SET city_id = $1 WHERE id = $2', [cityIds[0], master.id]);
      master.city_id = cityIds[0];
    }
    // The unique phone constraint selects exactly one first registration, even
    // under concurrent retries. Profile, balance and ledger commit together.
    if (isNew && welcomeBonusTetri > 0) {
      await client.query("INSERT INTO balance_transactions (master_id, amount_tetri, reason, note) VALUES ($1, $2, 'promo', 'WELCOME_AUTO')", [master.id, welcomeBonusTetri]);
    }
    await require('./partner.service').bindNew(master, isNew, referralToken, referralPromoCode, client);
    master.welcomeBonusTetri = isNew ? welcomeBonusTetri : 0;
    // bindNew пишет referral_manager_id в БД, но не в этот JS-объект — а он уходит
    // сразу в telegramService.notifyModeratorNewMaster(master) (см. master.controller),
    // которому нужны и id (маршрутизация — только владельцу ссылки), и имя (текст
    // уведомления — по чьей ссылке/промокоду пришла регистрация).
    const referral = (await client.query(
      'SELECT m.referral_manager_id, mgr.name AS referral_manager_name FROM masters m LEFT JOIN managers mgr ON mgr.id = m.referral_manager_id WHERE m.id = $1', [master.id]
    )).rows[0];
    master.referral_manager_id = referral?.referral_manager_id || null;
    master.referral_manager_name = referral?.referral_manager_name || null;

    if (serviceType) await client.query(
      `INSERT INTO master_services (master_id, service_type, attributes, is_primary)
       VALUES ($1, $2, $3::jsonb, true)
       ON CONFLICT (master_id, service_type) DO UPDATE SET attributes = EXCLUDED.attributes`,
      [master.id, serviceType, JSON.stringify(attributes || {})]
    );

    if (!serviceType) await client.query('DELETE FROM master_services WHERE master_id = $1', [master.id]);
    await client.query(`DELETE FROM master_districts WHERE master_id = $1`, [master.id]);
    for (const did of districtIds || []) {
      if (!Number.isFinite(Number(did))) continue;
      await client.query(
        `INSERT INTO master_districts (master_id, district_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [master.id, Number(did)]
      );
    }
    if (consentGrant) await consentLog.applyConsent(consentGrant, 'provider', master.id, phone, requestMeta, client, { declared_name: name });
    return master;
  });
}

async function getWorkCities() {
  const { rows } = await pool.query('SELECT id, slug, name_ka, name_ru, name_en FROM cities ORDER BY sort_order, id');
  return rows;
}

async function getActiveCities() {
  const { rows } = await pool.query(
    `SELECT id, slug, name_ka, name_ru, name_en FROM cities WHERE is_active = true ORDER BY sort_order`
  );
  return rows;
}

async function getDistrictsByCity(cityId) {
  const { rows } = await pool.query(
    `SELECT id, slug, name AS name_ka, name_ru, name_en FROM districts
     WHERE city_id = $1 ORDER BY sort_order, id`,
    [cityId]
  );
  return rows;
}

async function getMasterByToken(token) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason, created_at, master_token,
            telegram_id, telegram_linked_at, missed_dispatch_count, promo_code_used, manager_id, is_subscribed, subscription_until
     FROM masters WHERE master_token = $1`,
    [token]
  );
  return rows[0] || null;
}

// Привязка Telegram-чата к профилю. Сначала снимаем этот telegram_id с любого другого
// профиля (уникальный индекс не даст двум мастерам делить один чат), потом ставим.
// В той же транзакции, чтобы между «снять» и «поставить» не влезла параллельная привязка.
async function linkTelegram({ masterToken, phone, telegramId }) {
  if (!masterToken && !phone) throw new Error('linkTelegram requires masterToken or phone');
  const idColumn = masterToken ? 'master_token' : 'phone'; // литерал, не пользовательский ввод
  const idValue = masterToken || phone;
  return pool.withTransaction(async (client) => {
    await client.query(
      `UPDATE masters SET telegram_id = NULL, telegram_linked_at = NULL
       WHERE telegram_id = $1 AND ${idColumn} <> $2`,
      [telegramId, idValue]
    );
    const { rows } = await client.query(
      `UPDATE masters SET telegram_id = $1, telegram_linked_at = NOW()
       WHERE ${idColumn} = $2
       RETURNING id, name, category, master_token, telegram_id`,
      [telegramId, idValue]
    );
    return rows[0] || null;
  });
}

async function unlinkTelegram(masterToken) {
  const { rows } = await pool.query(
    `UPDATE masters SET telegram_id = NULL, telegram_linked_at = NULL
     WHERE master_token = $1 RETURNING id`,
    [masterToken]
  );
  return rows[0] || null;
}

// Лёгкий getter по id — для плашки «баланс / мой аккаунт» на странице лида и для
// ответа модератора в поддержке (нужен telegram_id, чтобы пингнуть).
async function getMasterById(id) {
  const { rows } = await pool.query(
    `SELECT is_technical, id, name, category, master_token, balance_tetri, is_active, is_banned, telegram_id,
            language, spoken_languages
     FROM masters WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getMasterByTelegramId(telegramId) {
  const { rows } = await pool.query(
    `SELECT is_technical, id, name, category, master_token, balance_tetri, is_active, is_banned, telegram_id, language
     FROM masters WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0] || null;
}

// Активность мастера для его личного кабинета: среднее время реакции + сколько
// уведомлений отвечено + лидов за 30 дней. Время реакции считается так же, как в
// adminService.getResponseStats (balance_transactions reason='lead_charge' —
// единственное место, где хранится связка «мастер X уведомлён о заявке Y в момент T»);
// при правке одного — синхронизировать второй. Без коррелированных подзапросов и
// date_trunc/INTERVAL — pg-mem (локальная разработка) их не тянет.
async function getMasterActivity(masterId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [respRes, recentRes] = await Promise.all([
    pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM responded_at) - EXTRACT(EPOCH FROM notified_at)) AS avg_seconds,
              COUNT(responded_at)::int AS responded_count,
              COUNT(*)::int AS total_count
       FROM (
         SELECT bt.order_id, bt.created_at AS notified_at, MIN(ov.viewed_at) AS responded_at
         FROM balance_transactions bt
         LEFT JOIN order_views ov
           ON ov.order_id = bt.order_id AND ov.master_id = bt.master_id AND ov.event_type IN ('view', 'call', 'whatsapp') AND ov.viewed_at >= bt.created_at
         WHERE bt.reason = 'lead_charge' AND bt.master_id = $1
         GROUP BY bt.order_id, bt.created_at
       ) sub`,
      [masterId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM balance_transactions
       WHERE master_id = $1 AND reason = 'lead_charge' AND created_at >= $2`,
      [masterId, since]
    ),
  ]);
  const r = respRes.rows[0];
  return {
    avgSeconds: r.avg_seconds === null ? null : Number(r.avg_seconds),
    respondedCount: r.responded_count,
    totalCount: r.total_count,
    leads30d: recentRes.rows[0].count,
  };
}

async function getMasterBalanceHistory(masterId, limit = 40) {
  const { rows } = await pool.query(
    `SELECT amount_tetri, reason, note, created_at
     FROM balance_transactions
     WHERE master_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [masterId, limit]
  );
  return rows;
}

// Все лиды, за которые с мастера реально списали деньги — balance_transactions
// (reason='lead_charge') это единственное место, где хранится связка «мастеру ушла
// заявка Y в момент T» (то же, что используют getMasterActivity / adminService.getResponseStats).
// Плюс отметка, связался ли он уже с клиентом (order_views call/whatsapp) — считаем
// в производной таблице, а не коррелированным подзапросом (pg-mem их не тянет, см. HANDOFF).
// Дедуп по order_id в JS: мастер с vehicle_size IS NULL может попасть под две рассылки
// одной заявки (все размеры + конкретный тир) и получить две строки lead_charge.
// masterCategory — категория этого мастера (masters.category); заявка может уходить
// сразу нескольким категориям (orders.target_categories), и закрыта бывает не вся
// целиком, а только часть (order_category_closures, см. order.service.closeOrderCategory)
// — is_closed_for_master учитывает и то, и другое: либо заявка закрыта целиком, либо
// закрыта именно категория этого мастера. Известное упрощение: сравнение по
// masters.category (для бортовых это 'transport', как и everywhere else в коде;
// отдельная синтетическая группа рассылки 'flatbed' тут не различается).
async function getMasterLeads(masterId, masterCategory = null, limit = 100) {
  const { rows } = await pool.query(
    `SELECT o.id, o.token, o.description, o.status, o.created_at, o.closed_at,
            (o.status = 'closed' OR occ.category IS NOT NULL) AS is_closed_for_master,
            bt.created_at AS notified_at,
            COALESCE(ev.call_count, 0) AS call_count,
            COALESCE(ev.whatsapp_count, 0) AS whatsapp_count,
            COALESCE(ev.view_count, 0) AS view_count
     FROM balance_transactions bt
     JOIN orders o ON o.id = bt.order_id
     LEFT JOIN (
       SELECT order_id,
              SUM(CASE WHEN event_type = 'call' THEN 1 ELSE 0 END)::int AS call_count,
              SUM(CASE WHEN event_type = 'whatsapp' THEN 1 ELSE 0 END)::int AS whatsapp_count,
              SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END)::int AS view_count
       FROM order_views
       WHERE master_id = $1
       GROUP BY order_id
     ) ev ON ev.order_id = o.id
     LEFT JOIN order_category_closures occ ON occ.order_id = o.id AND occ.category = $3
     WHERE bt.reason = 'lead_charge' AND bt.master_id = $1
     ORDER BY bt.created_at DESC
     LIMIT $2`,
    [masterId, limit, masterCategory]
  );

  const seen = new Set();
  return rows.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)));
}

async function approveMaster(id) {
  return pool.withTransaction(async client => {
    const found = await client.query('SELECT * FROM masters WHERE id = $1 FOR UPDATE', [id]);
    const master = found.rows[0];
    if (!master || master.is_banned) return null;
    const type = master.category === 'transport' ? 'van' : master.category;
    const config = require('./category.service');
    const definition = await config.get(type,client);
    const services = await client.query('SELECT * FROM master_services WHERE master_id = $1 AND service_type = $2', [id, type]);
    const service = services.rows[0];
    if (!service || config.validate(definition, service.attributes).errors.length) return null;
    const { rows } = await client.query('UPDATE masters SET is_active = true WHERE id = $1 RETURNING *', [id]);
    return rows[0];
  });
}

// Обратный ход approveMaster — админ может вернуть уже одобренного специалиста
// на модерацию (например, если одобрили по ошибке или нужно перепроверить анкету).
async function unapproveMaster(id) {
  const { rows } = await pool.query('UPDATE masters SET is_active = false WHERE id = $1 RETURNING *', [id]);
  return rows[0] || null;
}

async function setMasterLanguage(id, language) {
  const normalized = require('../config/i18n').normalizeLang(language);
  await pool.query('UPDATE masters SET language = $1 WHERE id = $2', [normalized, id]);
}

async function getMasterByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS}, is_active, balance_tetri, is_banned, banned_reason, master_token FROM masters WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

// Единственная точка изменения баланса — каждое изменение пишет строку в
// balance_transactions в той же транзакции, чтобы история никогда не разошлась
// с реальным balance_tetri. Передавайте client из pool.withTransaction(...),
// когда вызов идёт не изолированно (см. chargeMastersForLead, topUpBalance).
async function adjustBalance({ masterId, phone, amountTetri, reason, orderId = null, note = null }, client = null) {
  if (reason === 'topup' && !client) return pool.withTransaction(tx => adjustBalance({ masterId, phone, amountTetri, reason, orderId, note }, tx));
  client = client || pool;
  if (!masterId && !phone) throw new Error('adjustBalance requires masterId or phone');
  const idColumn = masterId ? 'id' : 'phone'; // литерал, не пользовательский ввод
  // Пополнение обнуляет счётчик пропущенных из-за баланса рассылок (см. notifyMasters).
  const resetMissed = reason === 'topup' ? ', missed_dispatch_count = 0' : '';
  const { rows } = await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1${resetMissed} WHERE ${idColumn} = $2 RETURNING *`,
    [amountTetri, masterId || phone]
  );
  const master = rows[0];
  if (!master) return null;
  const ledger = await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [master.id, amountTetri, reason, orderId, note]
  );
  await require('./partner.service').accrue(ledger.rows[0], master, client);
  return master;
}

// Списание за лид сразу по всем уведомлённым мастерам одним UPDATE + один multi-row
// INSERT в журнал (заодно фиксирует, кому реально ушло уведомление по заявке — эта
// связь раньше нигде не хранилась). Плейсхолдеры строятся вручную, как в
// getOrdersByTokens/attachFiles в order.service.js — не через ANY($::int[])/UNNEST:
// оба варианта не работают под pg-mem (используется для локальной разработки,
// dev-server.js), а IN (...) с явными плейсхолдерами работает одинаково и там, и на
// реальном Postgres.
async function chargeMastersForLead(masterIds, amountTetri, orderId, client = pool) {
  if (!masterIds.length) return;

  const idPlaceholders = masterIds.map((_, i) => `$${i + 2}`).join(', ');
  await client.query(
    `UPDATE masters SET balance_tetri = balance_tetri + $1 WHERE id IN (${idPlaceholders})`,
    [-amountTetri, ...masterIds]
  );

  const values = [];
  const rowPlaceholders = masterIds
    .map((masterId, i) => {
      const base = i * 3;
      values.push(masterId, -amountTetri, orderId);
      return `($${base + 1}, $${base + 2}, 'lead_charge', $${base + 3})`;
    })
    .join(', ');
  const charges = await client.query(
    `INSERT INTO balance_transactions (master_id, amount_tetri, reason, order_id) VALUES ${rowPlaceholders} RETURNING id, master_id`,
    values
  );
  return charges.rows;
}

async function topUpBalance(phone, amountTetri) {
  return pool.withTransaction((client) => adjustBalance({ phone, amountTetri, reason: 'topup' }, client));
}

// Редактирование профиля из админки — единственное место, где допускается менять
// category/vehicle_size вручную (при саморегистрации на /join vehicle_size сознательно
// остаётся NULL — «любой размер», см. HANDOFF.md; тут модератор может сузить конкретного
// мастера до одного тира).
async function updateMasterProfile(id, { name, phone, category, vehicleType, vehicleSize, isFlatbed, priceText, description, serviceAttributes = {} }) {
  const config = require('../config/serviceTypes');
  const type = category === 'transport' ? 'van' : category;
  const categories = require('./category.service');
  const definition = await categories.get(type);
  const checked = categories.validate(definition, serviceAttributes);
  if (type !== definition?.slug || checked.errors.length) {
    const error = new Error('Заполните категорию и обязательные характеристики'); error.code = 'INVALID_SERVICE'; throw error;
  }
  if (type === 'van' && config.VAN_SIZE_ORDER.includes(vehicleSize)) checked.attributes.size = vehicleSize;
  const legacy = config.legacyColumnsFor(type, checked.attributes);
  return pool.withTransaction(async client => {
    await client.query('SELECT id FROM masters WHERE id = $1 FOR UPDATE', [id]);
    const { rows } = await client.query(
      'UPDATE masters SET name=$1, phone=$2, category=$3, vehicle_type=$4, vehicle_size=$5, is_flatbed=$6, price_text=$7, description=$8 WHERE id=$9 RETURNING *',
      [name, phone, legacy.category, vehicleType || null, legacy.vehicle_size, legacy.is_flatbed, priceText || null, description || null, id]);
    if (!rows[0]) return null;
    await client.query('DELETE FROM master_services WHERE master_id=$1', [id]);
    await client.query('INSERT INTO master_services (master_id, service_type, attributes, is_primary) VALUES ($1,$2,$3::jsonb,true)', [id,type,JSON.stringify(checked.attributes)]);
    return rows[0];
  });
}

// Админ стирает тестовый/мусорный профиль исполнителя целиком, чтобы освободить его
// номер для повторной регистрации на /join (masters.phone — UNIQUE; бан не освобождает
// номер, только прячет профиль). master_districts/order_views/balance_transactions/
// support_messages/master_reviews/master_services/master_cities каскадируются схемой
// (ON DELETE CASCADE) сами; остальные таблицы на masters(id) — без каскада (RESTRICT
// по умолчанию), чистим явно, тем же приёмом, что deleteOrder чистит dispatch_*.
// sms_consent_logs НЕ трогаем — тот же принцип, что в deleteOrder: журнал согласий
// обязан пережить удаление профиля нарочно (см. schema.postgres.sql,
// trg_sms_consent_logs_append_only — на проде UPDATE/DELETE там блокирует триггер).
async function deleteMaster(id, { meta = {} } = {}) {
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT * FROM masters WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!master) return null;
    await consentLog.recordAction({ eventType: 'MASTER_DELETED', phone: master.phone, masterId: master.id,
      metadata: { name: master.name, category: master.category, is_technical: master.is_technical }, meta }, client);
    await client.query('DELETE FROM manager_commissions WHERE master_id = $1', [id]);
    await client.query(
      `UPDATE bank_statement_credits SET topup_id = NULL
       WHERE topup_id IN (SELECT id FROM topup_requests WHERE master_id = $1)`, [id]);
    await client.query('DELETE FROM topup_receipts WHERE master_id = $1', [id]);
    await client.query('DELETE FROM topup_requests WHERE master_id = $1', [id]);
    await client.query('DELETE FROM card_payments WHERE master_id = $1', [id]);
    await client.query('UPDATE crm_invites SET master_id = NULL WHERE master_id = $1', [id]);
    await client.query('UPDATE manager_portal_events SET master_id = NULL WHERE master_id = $1', [id]);
    await client.query('DELETE FROM dispatch_deliveries WHERE master_id = $1', [id]);
    await client.query('DELETE FROM masters WHERE id = $1', [id]);
    return master;
  });
}

// balance_tetri — только чтобы каталог мог решить, показывать ли кнопку «Показать номер»
// (см. revealPhoneForCall). Сам номер (m.phone) сюда попадает для server-side рендера
// каталога; JSON-ручка /api/masters (masterController.list) обязана его вычищать перед
// отдачей клиенту — иначе платный gate на «показать номер» тривиально обходится.
const LIST_FIELDS = 'm.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url, m.balance_tetri, m.city_id';

// Каталог группирует по service_type из master_services. Тип и attributes подтягиваем
// вторым запросом и клеим в JS (а не join + GROUP BY по jsonb — pg-mem не тянет).
// Один мастер = одна карточка: берём primary-услугу (все мигрированные/новые — primary).
async function listMasters({ serviceType } = {}) {
  const { rows } = await pool.query(
    `SELECT ${LIST_FIELDS}, COALESCE(AVG(r.rating)::numeric(3,2), 0) AS rating, COUNT(r.id)::int AS review_count
     FROM masters m
     LEFT JOIN master_reviews r ON r.master_id = m.id AND r.is_approved = true
     WHERE m.is_technical = false AND m.is_active = true AND m.is_banned = false
     GROUP BY m.id, m.name, m.phone, m.category, m.vehicle_type, m.vehicle_size, m.price_text, m.description, m.avatar_url, m.balance_tetri, m.city_id
     ORDER BY m.id`
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: services } = await pool.query(
    `SELECT master_id, service_type, attributes, is_primary FROM master_services WHERE master_id IN (${ph})`,
    ids
  );
  const byMaster = new Map();
  for (const s of services) {
    const cur = byMaster.get(s.master_id);
    if (!cur || (s.is_primary && !cur.is_primary)) byMaster.set(s.master_id, s);
  }

  const billing = require('./providerBilling.service');
  const billingIds = await billing.eligibleIds(await billing.pricing());
  const result = rows.map((m) => {
    const s = byMaster.get(m.id);
    return {
      ...m,
      billing_accepted: billingIds.has(m.id),
      service_type: s ? s.service_type : (m.category === 'movers' ? 'movers' : 'van'),
      attributes: s ? s.attributes || {} : {},
    };
  });
  const active = new Set((await require('./category.service').list()).filter(c=>c.is_active).map(c=>c.slug));
  return result.filter(m => active.has(m.service_type) && (!serviceType || m.service_type === serviceType));
}

// Списание за раскрытие номера в публичном каталоге — атомарно: UPDATE с условием на
// баланс сам по себе исключает гонку (два одновременных клика не спишут дважды при
// недостаточном балансе), без явного SELECT ... FOR UPDATE. 0 обновлённых строк =
// баланса не хватило / мастер уже неактивен/забанен/удалён — вызывающий код трактует
// null как «недоступен», не как ошибку.
//
// ⚠️ `balance_tetri + $1` с ОТРИЦАТЕЛЬНЫМ параметром, а не `balance_tetri - $1` с
// положительным — на pg-mem вычитание параметра (не литерала) из колонки в SET даёт
// результат с обратным знаком (баг найден 2026-09-05: `col - $1` считается как `$1 - col`,
// а `col - 50` — верно). Тот же идиом уже используют adjustBalance/chargeMastersForLead
// в этом файле — держим его и здесь, а не только чтобы обойти баг pg-mem.
async function revealPhoneForCall(masterId, priceTetri, callerPhone) {
  return pool.withTransaction(async (client) => {
    const found = (await client.query('SELECT * FROM masters WHERE id=$1 FOR UPDATE', [masterId])).rows[0];
    if (!found) return null;
    const billing = require('./providerBilling.service');
    const rates = await billing.pricing(client, true);
    const acceptance = await billing.accepted(masterId, rates, client);
    if (!acceptance || rates.catalogCallPriceTetri !== priceTetri) return null;
    const { rows } = await client.query(
      `UPDATE masters SET balance_tetri = balance_tetri + $1
       WHERE id = $2 AND is_technical = false AND is_active = true AND is_banned = false AND balance_tetri >= $3
       RETURNING id, phone, balance_tetri`,
      [-priceTetri, masterId, priceTetri]
    );
    const master = rows[0];
    if (!master) return null;
    const charge = await client.query(
      `INSERT INTO balance_transactions (master_id, amount_tetri, reason, note) VALUES ($1, $2, 'catalog_call', $3) RETURNING id`,
      [master.id, -priceTetri, callerPhone ? `Звонок из каталога: ${callerPhone}` : null]
    );
    await consentLog.recordAction({ eventType: 'CATALOG_CHARGE_ACCEPTED', phone: master.phone, masterId: master.id,
      metadata: { amount_tetri: priceTetri, balance_transaction_id: charge.rows[0].id,
        billing_consent_log_id: acceptance.consent_log_id, pricing_key: rates.key } }, client);
    return master;
  });
}

module.exports = {
  registerMaster,
  setMasterLanguage,
  getWorkCities,
  getActiveCities,
  getDistrictsByCity,
  getMasterByToken,
  getMasterById,
  getMasterByTelegramId,
  getMasterByPhone,
  getMasterActivity,
  getMasterBalanceHistory,
  getMasterLeads,
  linkTelegram,
  unlinkTelegram,
  approveMaster,
  unapproveMaster,
  updateMasterProfile,
  deleteMaster,
  adjustBalance,
  chargeMastersForLead,
  topUpBalance,
  listMasters,
  revealPhoneForCall,
};
