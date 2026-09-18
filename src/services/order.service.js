const consentLog = require('./consentLog.service');
const pool = require('../config/db');
const redis = require('../config/redis');
const smsService = require('./sms.service');
const masterService = require('./master.service');
const settingsService = require('./settings.service');
const technical = require('./technical.service');
const { getBaseUrl } = require('../config/url');
const { generateShortId } = require('../config/shortId');

// Цена лида теперь в БД (app_settings, правится в /admin/settings) — settingsService
// её читает, тут только порог «баланс заканчивается» как множитель цены (~5 лидов).
const LOW_BALANCE_NUDGE_LEADS = 5;
const NUDGE_THROTTLE_SECONDS = 24 * 60 * 60;

// Разовый (не чаще раза в сутки) пинок «пополни баланс» — в Telegram, если привязан,
// иначе SMS. reason: 'low' (списание уронило баланс) | 'missed' (не хватило на лид).
async function nudgeLowBalance(master, telegramService, reason) {
  const key = `lowbal_nudge:${master.is_technical ? 'technical:' : ''}${master.id}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, NUDGE_THROTTLE_SECONDS);
  if (n > 1) return;

  const link = `${getBaseUrl()}/master/${master.master_token}`;
  const gel = (master.balance_tetri / 100).toFixed(2);
  try {
    if (master.telegram_id) {
      const text = reason === 'missed'
        ? `⚠️ Заявка по вашей категории ушла мимо — не хватило баланса. Пополните, чтобы снова получать заявки: ${link}`
        : `⚠️ Баланс ${gel} ₾ заканчивается. Пополните, чтобы не пропускать заявки: ${link}`;
      await telegramService.sendToChat(master.telegram_id, text);
    } else {
      const text = reason === 'missed'
        ? `Xtender: an order in your category passed you by (low balance). Top up: ${link}`
        : `Xtender: balance low (${gel} GEL). Top up to keep getting orders: ${link}`;
      await smsService.sendOrderNotification(master.phone, text, { masterId: master.id });
    }
  } catch (err) {
    console.error(`Failed to nudge master ${master.id} about low balance:`, err.message);
  }
}

async function createPendingOrder({ phone, description, districtName, managerId = null }) {
  const token = generateShortId();
  const ownerToken = generateShortId();
  const { rows } = await pool.query(
    `INSERT INTO orders (phone, description, district_name, token, owner_token, target_categories, status, manager_id)
     VALUES ($1, $2, $3, $4, $5, '{}', 'unverified', $6) RETURNING *`,
    [phone, description, districtName, token, ownerToken, managerId]
  );
  return rows[0];
}

async function getOrderByOwnerToken(ownerToken) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE owner_token = $1', [ownerToken]);
  return rows[0] || null;
}

async function activateOrder(token, phone, grant, meta = {}, files = []) {
  if (!grant) return null;
  return pool.withTransaction(async client => {
    const isTechnical = await technical.isClientPhone(phone, client);
    if (grant.draftDetails) await client.query("UPDATE orders SET description=$4,district_name=$5 WHERE id=$1 AND token=$2 AND phone=$3 AND status='unverified'",[grant.orderId,token,phone,grant.draftDetails.description,grant.draftDetails.districtName]);
    const { rows } = await client.query(
      "UPDATE orders SET status = 'pending_review', confirmed_at=NOW(), is_technical=$4 WHERE token = $1 AND phone = $2 AND id = $3 AND status = 'unverified' RETURNING *",
      [token, phone, grant.orderId, isTechnical]);
    const order = rows[0];
    if (!order) return null;
    await attachFiles(order.id, files, client);
    await consentLog.applyConsent(grant, 'client', order.id, phone, meta, client);
    await consentLog.recordAction({ eventType: 'ORDER_DETAILS_RECORDED', phone, orderId: order.id,
      metadata: { description: order.description, district_name: order.district_name, is_technical: order.is_technical }, meta }, client);
    return order;
  });
}

async function setModerationMessageId(orderId, messageId) {
  await pool.query('UPDATE orders SET moderation_message_id = $1 WHERE id = $2', [messageId, orderId]);
}

async function saveTranslations(orderId, sourceLang, translations) {
  await pool.query(
    `UPDATE orders SET source_lang = $1, description_translations = $2::jsonb WHERE id = $3`,
    [sourceLang, JSON.stringify(translations || {}), orderId]
  );
}

// Сообщения о заявке во всех чатах модераторов — чтобы updateMessage правил воронку
// у каждого. [{ chatId, messageId }]. Плейсхолдеры вручную (не ANY/UNNEST — pg-mem).
async function recordModerationMessages(orderId, entries) {
  if (!entries || !entries.length) return;
  const values = [];
  const rows = entries
    .map((e, i) => {
      const b = i * 3;
      values.push(orderId, String(e.chatId), String(e.messageId));
      return `($${b + 1}, $${b + 2}, $${b + 3})`;
    })
    .join(', ');
  await pool.query(
    `INSERT INTO order_moderation_messages (order_id, chat_id, message_id) VALUES ${rows}
     ON CONFLICT (order_id, chat_id) DO UPDATE SET message_id = EXCLUDED.message_id`,
    values
  );
}

async function getModerationMessages(orderId) {
  const { rows } = await pool.query(
    'SELECT chat_id, message_id FROM order_moderation_messages WHERE order_id = $1',
    [orderId]
  );
  return rows;
}

async function getOrderByToken(token) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE token = $1', [token]);
  return rows[0] || null;
}

async function getOrdersByTokens(tokens) {
  if (!tokens || !tokens.length) return [];
  const placeholders = tokens.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE token IN (${placeholders}) ORDER BY created_at DESC`,
    tokens
  );
  return rows;
}

async function recordDispatch(orderId, category, vehicleSize, revision = null) {
  try {
    return await pool.withTransaction(async client => {
      const claimed = await client.query("UPDATE orders SET status = 'new', first_dispatched_at = COALESCE(first_dispatched_at, NOW()) WHERE id = $1 AND status IN ('pending_review','new') AND ($2::integer IS NULL OR revision_version = $2) RETURNING id", [orderId, revision]);
      if (!claimed.rows.length) return false;
      await client.query('INSERT INTO order_dispatches (order_id, category, vehicle_size) VALUES ($1, $2, $3)', [orderId, category, vehicleSize || '']);
      return true;
    });
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function getOrderDispatches(orderId) {
  const { rows: dispatches } = await pool.query(
    `SELECT category, vehicle_size FROM order_dispatches WHERE order_id = $1 ORDER BY dispatched_at`,
    [orderId]
  );
  if (!dispatches.length) return [];

  const order = (await pool.query('SELECT is_technical FROM orders WHERE id=$1', [orderId])).rows[0];
  const counts = await getMasterCountsByCategory(order?.is_technical === true);
  const totalFor = (category) =>
    counts.filter((row) => row.category === category).reduce((sum, row) => sum + row.count, 0);
  const sizedFor = (category, size) => {
    const row = counts.find((row) => row.category === category && row.vehicle_size === size);
    return row ? row.count : 0;
  };

  return dispatches.map((d) => ({
    category: d.category,
    vehicle_size: d.vehicle_size,
    master_count: d.vehicle_size ? sizedFor(d.category, d.vehicle_size) : totalFor(d.category),
  }));
}

async function addTargetCategories(token, categories) {
  const existing = await getOrderByToken(token);
  if (!existing || existing.status === 'closed') return null;

  const merged = [...new Set([...(existing.target_categories || []), ...categories])];
  const { rows } = await pool.query(
    `UPDATE orders SET target_categories = $1,
         status = CASE WHEN status = 'pending_review' THEN 'new' ELSE status END
     WHERE token = $2 RETURNING *`,
    [merged, token]
  );
  return rows[0] || null;
}

async function markFirstDispatch(token) {
  const { rows } = await pool.query(
    `UPDATE orders SET first_dispatched_at = NOW()
     WHERE token = $1 AND first_dispatched_at IS NULL RETURNING *`,
    [token]
  );
  return Boolean(rows[0]);
}

// Общее ядро полного закрытия — вызывается и напрямую (closeOrder), и из
// closeOrderCategory, когда закрываемая категория оказалась последней открытой
// (тогда заявка закрывается целиком тем же путём, что и раньше, без отдельной
// ветки логирования). client обязателен — вызывающий уже открыл транзакцию.
async function finalizeClose(client, token, { actor = 'admin', reason = 'admin_closed', meta = {} } = {}) {
  const { rows } = await client.query(
    "UPDATE orders SET status = 'closed', closed_at = NOW(), closed_by=$2, closing_reason=$3 WHERE token = $1 AND status != 'closed' RETURNING *", [token,actor,reason]);
  const order = rows[0];
  if (!order) return null;
  await consentLog.recordAction({ eventType: 'ORDER_CLOSED', phone: order.phone, orderId: order.id,
    metadata: { actor, reason, stops_future_contact_sharing: true }, meta }, client);
  if (actor === 'client') await consentLog.recordAction({ eventType: 'CONTACT_SHARING_WITHDRAWN', phone: order.phone,
    orderId: order.id, metadata: { actor, reason, scope: 'this_order' }, meta }, client);
  return order;
}

async function closeOrder(token, opts = {}) {
  return pool.withTransaction(client => finalizeClose(client, token, opts));
}

// Закрытие одной категории многокатегорийной заявки (target_categories), не
// всей заявки — см. docs про заявку из нескольких категорий (грузчики + машина
// в одной заявке). Тихий no-op (возвращает order как есть), если заявки нет,
// она уже закрыта целиком, категория не входит в target_categories или уже
// закрыта раньше — тот же принцип, что и у повторного closeOrder на закрытой
// заявке. Когда закрываемая категория — последняя ещё открытая, заявка
// закрывается целиком через finalizeClose (тот же код пути, что и обычный
// close), поэтому весь остальной код, читающий orders.status, не меняется.
async function closeOrderCategory(token, category, { actor = 'admin', reason = 'admin_closed', meta = {} } = {}) {
  return pool.withTransaction(async client => {
    const order = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE', [token])).rows[0];
    if (!order || order.status === 'closed') return order || null;
    const targets = order.target_categories || [];
    if (!targets.includes(category)) return order;
    const closedRows = await client.query('SELECT category FROM order_category_closures WHERE order_id=$1', [order.id]);
    const closedSet = new Set(closedRows.rows.map(r => r.category));
    if (closedSet.has(category)) return order;

    const remaining = targets.filter(c => c !== category && !closedSet.has(c));
    if (!remaining.length) return finalizeClose(client, token, { actor, reason, meta });

    await client.query('INSERT INTO order_category_closures(order_id,category,closed_by,reason) VALUES($1,$2,$3,$4)', [order.id, category, actor, reason]);
    await consentLog.recordAction({ eventType: 'ORDER_CATEGORY_CLOSED', phone: order.phone, orderId: order.id,
      metadata: { actor, reason, category, remaining_categories: remaining }, meta }, client);
    if (actor === 'client') await consentLog.recordAction({ eventType: 'CONTACT_SHARING_WITHDRAWN', phone: order.phone,
      orderId: order.id, metadata: { actor, reason, scope: 'category:' + category }, meta }, client);
    return order;
  });
}

async function getClosedCategories(orderId) {
  const { rows } = await pool.query('SELECT category FROM order_category_closures WHERE order_id=$1', [orderId]);
  return rows.map(r => r.category);
}

// Админ удаляет мусорную/тестовую заявку целиком, а не закрывает. dispatch_runs/
// dispatch_deliveries не каскадируют по FK (RESTRICT по умолчанию, без ON DELETE) —
// удаляем их здесь явно, до самой заявки. order_views/order_files/order_dispatches/
// order_moderation_messages/master_reviews каскадируются схемой сами.
// balance_transactions.order_id уходит в NULL схемой — списание с баланса мастера
// остаётся в истории, просто теряет ссылку на удалённую заявку. crm_invites.order_id
// отвязываем (сам инвайт менеджера — самостоятельная запись, не только про эту заявку).
// sms_consent_logs НЕ трогаем: журнал согласий переживает удаление заявки нарочно.
async function deleteOrder(token, { meta = {} } = {}) {
  return pool.withTransaction(async client => {
    const order = (await client.query("SELECT * FROM orders WHERE token = $1", [token])).rows[0];
    if (!order) return null;
    await consentLog.recordAction({ eventType: 'ORDER_DELETED', phone: order.phone, orderId: order.id,
      metadata: { description: order.description, status: order.status, is_technical: order.is_technical }, meta }, client);
    await client.query('UPDATE crm_invites SET order_id = NULL WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM dispatch_deliveries WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM dispatch_runs WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM orders WHERE id = $1', [order.id]);
    return order;
  });
}

async function getMasterCountsByCategory(isTechnical = false) {
  const leadPrice = await settingsService.getLeadPriceTetri();
  const { rows } = await pool.query(
    `SELECT category, vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_technical = $2 AND is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
     GROUP BY category, vehicle_size
     UNION ALL
     SELECT 'flatbed' AS category, NULL AS vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_technical = $2 AND is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
       AND category = 'transport' AND is_flatbed = true`,
    [leadPrice, isTechnical === true]
  );
  return rows;
}

const EVENT_TYPES = ['view', 'call', 'whatsapp'];

async function getOrderFunnelStats(orderId) {
  const { rows } = await pool.query(
    `SELECT event_type, COUNT(*)::int AS count FROM order_views
     WHERE order_id = $1 GROUP BY event_type`,
    [orderId]
  );
  const stats = { view: 0, call: 0, whatsapp: 0 };
  rows.forEach((row) => {
    stats[row.event_type] = row.count;
  });
  return stats;
}

// Воронка заявки в разрезе групп исполнителей (masters.category) — чтобы видеть, какая
// группа откликается (заявка на «грузчики + машина» уходит двум группам сразу).
// received — мастера, которым лид реально ушёл: dispatch_deliveries.status='accepted', а для
// заявок до 2026-09-13, когда доставки ещё не писались, — списание lead_charge.
// contacted — «отклик»: мастер позвонил ИЛИ написал в WhatsApp (просмотр откликом не считаем,
// как и в crmMetrics). order_views уникален по (заявка, мастер, тип), поэтому view/call/whatsapp
// уже считают уникальных мастеров; contacted — уникальные мастера из call ∪ whatsapp.
// Агрегируем в JS, а не в SQL: COUNT(DISTINCT)/FILTER на pg-mem (dev-server) ненадёжны.
// Группа 'flatbed' — это не masters.category, а подвыборка transport (is_flatbed), поэтому
// в разрезе она учитывается как transport.
async function getOrderFunnelByCategory(orderId) {
  const [dispatched, delivered, charged, events] = await Promise.all([
    pool.query('SELECT category FROM order_dispatches WHERE order_id = $1 ORDER BY dispatched_at', [orderId]),
    pool.query(
      `SELECT m.id AS master_id, m.category FROM dispatch_deliveries dd
       JOIN masters m ON m.id = dd.master_id WHERE dd.order_id = $1 AND dd.status = 'accepted'`,
      [orderId]
    ),
    pool.query(
      `SELECT m.id AS master_id, m.category FROM balance_transactions bt
       JOIN masters m ON m.id = bt.master_id WHERE bt.order_id = $1 AND bt.reason = 'lead_charge'`,
      [orderId]
    ),
    pool.query(
      `SELECT m.id AS master_id, m.category, ov.event_type FROM order_views ov
       JOIN masters m ON m.id = ov.master_id WHERE ov.order_id = $1`,
      [orderId]
    ),
  ]);

  const groups = new Map();
  const groupFor = (category) => {
    const key = category || '';
    if (!groups.has(key)) {
      groups.set(key, { category: key, received: new Set(), view: new Set(), call: new Set(), whatsapp: new Set() });
    }
    return groups.get(key);
  };

  // Сначала группы, в которые заявку рассылали (в порядке рассылки) — чтобы группа, где ещё
  // никто не получил лид, тоже была видна нулями, а не пропадала из отчёта.
  dispatched.rows.forEach((row) => groupFor(row.category === 'flatbed' ? 'transport' : row.category));
  [...delivered.rows, ...charged.rows].forEach((row) => groupFor(row.category).received.add(row.master_id));
  events.rows.forEach((row) => {
    if (EVENT_TYPES.includes(row.event_type)) groupFor(row.category)[row.event_type].add(row.master_id);
  });

  return [...groups.values()].map((g) => ({
    category: g.category,
    received: g.received.size,
    view: g.view.size,
    call: g.call.size,
    whatsapp: g.whatsapp.size,
    contacted: new Set([...g.call, ...g.whatsapp]).size,
  }));
}

function dispatchFilter(category, vehicleSize, isTechnical = false) {
  // Условие по категории/размеру строим один раз — оно нужно и для «кому разослать»
  // (баланс есть), и для «кто подходил, но денег не хватило» (missed). $1 = цена лида.
  const catParams = [];
  let catClause;
  if (category === 'flatbed') {
    catClause = ` AND category = 'transport' AND is_flatbed = true`;
  } else {
    catParams.push(category);
    catClause = ` AND category = $${catParams.length + 1}`;
    if (vehicleSize) {
      catParams.push(vehicleSize);
      catClause += ` AND (vehicle_size = $${catParams.length + 1} OR vehicle_size IS NULL)`;
    }
  }
  const activeWhere = `is_technical = ${isTechnical === true ? 'true' : 'false'} AND is_active = true AND is_subscribed = true AND is_banned = false
                       AND (subscription_until IS NULL OR subscription_until > NOW())`;


 return { activeWhere, catParams, catClause };
}
async function getDispatchRecipients(category, vehicleSize, leadPrice, isTechnical = false) {
 const catalog = require('./category.service');
 const definition = await catalog.get(category);
 if (!definition?.is_active) return [];
 const { activeWhere, catParams, catClause } = dispatchFilter(category, vehicleSize, isTechnical);
 const { rows } = await pool.query(`SELECT id, phone, telegram_id, master_token, balance_tetri, manager_id FROM masters WHERE ${activeWhere} AND balance_tetri >= $1${catClause}`, [leadPrice, ...catParams]);
 if (!definition.is_builtin && rows.length) {
   const services = (await pool.query('SELECT master_id, attributes FROM master_services WHERE service_type=$1',[definition.slug])).rows;
   return rows.filter(m=>services.some(s=>s.master_id===m.id && !catalog.validate(definition,s.attributes).errors.length));
 }
 return rows;
}
async function notifyMasters(order, category, vehicleSize, confirmedPrice = null) {
  if (!order) return 0;
  // Always use persisted routing, never a flag supplied by a caller or old preview.
  order = await getOrderByToken(order.token);
  if (!order || !['pending_review', 'new'].includes(order.status)) return 0;
  const isTechnical = order.is_technical === true;
  const telegramService = require('./telegram.service');
  const leadPrice = confirmedPrice ?? await settingsService.getLeadPriceTetri();
  const lowBalanceNudgeTetri = leadPrice * LOW_BALANCE_NUDGE_LEADS;
  const masters = await getDispatchRecipients(category, vehicleSize, leadPrice, isTechnical);
  const run = (await pool.query('INSERT INTO dispatch_runs(order_id) VALUES($1) RETURNING id', [order.id])).rows[0];
  for (const master of masters) await pool.query('INSERT INTO dispatch_deliveries(run_id,order_id,master_id,manager_id) VALUES($1,$2,$3,$4)', [run.id,order.id,master.id,master.manager_id]);
  const notifiedIds = [];
  // A row lock serializes routing changes against delivery and charging. Limit
  // concurrency so background SMS auditing can still obtain a pool connection.
  for (let offset = 0; offset < masters.length; offset += 4) {
   await Promise.all(masters.slice(offset, offset + 4).map(async candidate => {
    let outcome = 'skipped';
    await technical.withMaster(candidate.id, isTechnical, async (master, client) => {
      const live = (await client.query('SELECT status FROM orders WHERE id=$1', [order.id])).rows[0];
      if (!live || !['pending_review','new'].includes(live.status) || !master.is_active || master.is_banned || !master.is_subscribed ||
          (master.subscription_until && new Date(master.subscription_until) <= new Date()) || master.balance_tetri < leadPrice) return;
      const link = getBaseUrl() + '/order/' + order.token + '?master=' + master.id;
      let delivered = false;
      if (master.telegram_id) delivered = await telegramService.sendLeadToMaster(master, order, link).catch(() => false);
      if (!delivered) {
        try {
          await smsService.sendOrderNotification(master.phone, 'Xtender: ' + (isTechnical ? '[TEST] ' : '') + 'new order #' + order.id + ': ' + link,
            { kind: 'lead', masterId: master.id, orderId: order.id });
          delivered = true;
        } catch (err) { console.error('Failed to notify master ' + master.id + ':', err.message); }
      }
      outcome = delivered ? 'accepted' : 'failed';
      if (delivered) {
        await masterService.chargeMastersForLead([master.id], leadPrice, order.id, client);
        notifiedIds.push(master.id);
        if (master.balance_tetri >= lowBalanceNudgeTetri && master.balance_tetri - leadPrice < lowBalanceNudgeTetri)
          await nudgeLowBalance({ ...master, balance_tetri: master.balance_tetri - leadPrice }, telegramService, 'low');
      }
      await client.query('UPDATE dispatch_deliveries SET status=$3,finished_at=NOW() WHERE run_id=$1 AND master_id=$2', [run.id,master.id,outcome]);
    });
    if (outcome === 'skipped') await pool.query("UPDATE dispatch_deliveries SET status='skipped',finished_at=NOW() WHERE run_id=$1 AND master_id=$2", [run.id,candidate.id]);
   }));
  }
  const { activeWhere, catParams, catClause } = dispatchFilter(category, vehicleSize, isTechnical);
  const { rows: broke } = await pool.query('SELECT id FROM masters WHERE ' + activeWhere + ' AND balance_tetri < $1' + catClause, [leadPrice, ...catParams]);
  for (const candidate of broke) {
    if (notifiedIds.includes(candidate.id)) continue;
    await technical.withMaster(candidate.id, isTechnical, async (master, client) => {
      if (!master.is_active || master.is_banned || !master.is_subscribed || master.balance_tetri >= leadPrice) return;
      await client.query('UPDATE masters SET missed_dispatch_count = missed_dispatch_count + 1 WHERE id=$1', [master.id]);
      await nudgeLowBalance(master, telegramService, 'missed');
    });
  }
  return notifiedIds.length;
}

async function attachFiles(orderId, files, client = pool) {
  if (!files || !files.length) return;

  const values = [];
  const placeholders = files
    .map((file, i) => {
      const base = i * 4;
      values.push(orderId, `/uploads/${file.filename}`, file.originalname, file.mimetype);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    })
    .join(', ');

  await client.query(
    `INSERT INTO order_files (order_id, file_path, original_name, mime_type) VALUES ${placeholders}`,
    values
  );
}

async function getOrderFiles(orderId) {
  const { rows } = await pool.query(
    'SELECT id, file_path, original_name, mime_type FROM order_files WHERE order_id = $1 ORDER BY id',
    [orderId]
  );
  return rows;
}

async function logView(orderId, masterId, eventType) {
  const type = EVENT_TYPES.includes(eventType) ? eventType : 'view';
  await pool.query(
    `INSERT INTO order_views (order_id, master_id, event_type) VALUES ($1, $2, $3)
     ON CONFLICT (order_id, master_id, event_type) DO NOTHING`,
    [orderId, masterId, type]
  );
}

module.exports = {
  getDispatchRecipients,
  createPendingOrder,
  activateOrder,
  getOrderByToken,
  getOrderByOwnerToken,
  getOrdersByTokens,
  addTargetCategories,
  recordDispatch,
  getOrderDispatches,
  markFirstDispatch,
  setModerationMessageId,
  saveTranslations,
  recordModerationMessages,
  getModerationMessages,
  closeOrder,
  closeOrderCategory,
  getClosedCategories,
  deleteOrder,
  notifyMasters,
  getMasterCountsByCategory,
  getOrderFunnelStats,
  getOrderFunnelByCategory,
  logView,
  attachFiles,
  getOrderFiles,
};
