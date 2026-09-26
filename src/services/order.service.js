const consentLog = require('./consentLog.service');
const pool = require('../config/db');
const redis = require('../config/redis');
const smsService = require('./sms.service');
const masterService = require('./master.service');
const settingsService = require('./settings.service');
const technical = require('./technical.service');
const billing = require('./providerBilling.service');
const matching = require('./serviceMatching.service');
const { getBaseUrl } = require('../config/url');
const { generateShortId } = require('../config/shortId');
const serviceMessage = require('../config/service-message-copy');
const { speaks } = require('../config/spokenLanguages');

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
  const messageKey = reason === 'missed' ? 'balanceMissed' : 'balanceLow';
  try {
    if (master.telegram_id) {
      // Telegram carries the provider's language; the SMS body stays Latin (see service-message-copy.js).
      await telegramService.sendToChat(master.telegram_id, serviceMessage(messageKey, master.language, { amount: gel, link }));
    } else {
      await smsService.sendOrderNotification(master.phone, serviceMessage.sms(messageKey, { amount: gel, link }), { masterId: master.id });
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

// Use the customer's recorded interface language, not the moderator's language
// or the automatically detected language of the request description.
async function getCustomerLanguage(order, fallback = 'ka') {
  const { rows } = await pool.query(`SELECT l.consent_language FROM consent_uses u
    JOIN sms_consent_logs l ON l.id=u.consent_log_id
    WHERE u.subject_role='client' AND u.subject_id=$1
    ORDER BY l.id DESC LIMIT 1`, [order.id]);
  const language = rows[0]?.consent_language;
  return ['ka', 'ru', 'en'].includes(language) ? language
    : ['ka', 'ru', 'en'].includes(fallback) ? fallback : 'ka';
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

async function recordDispatch(orderId, category, vehicleSize, revision = null, language = '') {
  try {
    return await pool.withTransaction(async client => {
      const claimed = await client.query("UPDATE orders SET status = 'new', first_dispatched_at = COALESCE(first_dispatched_at, NOW()) WHERE id = $1 AND status IN ('pending_review','new') AND ($2::integer IS NULL OR revision_version = $2) RETURNING id", [orderId, revision]);
      if (!claimed.rows.length) return false;
      await client.query('INSERT INTO order_dispatches (order_id, category, vehicle_size, language) VALUES ($1, $2, $3, $4)', [orderId, category, vehicleSize || '', language || '']);
      return true;
    });
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function getOrderDispatches(orderId) {
  const runs = (await pool.query('SELECT * FROM dispatch_runs WHERE order_id=$1 ORDER BY created_at', [orderId])).rows;
  const deliveries = (await pool.query('SELECT * FROM dispatch_deliveries WHERE order_id=$1', [orderId])).rows.map(d=>({...d,matched_categories:Array.isArray(d.matched_categories)?d.matched_categories:[],service_snapshot:Array.isArray(d.service_snapshot)?d.service_snapshot:[]}));
  return runs.map(run=>{
    const rows=deliveries.filter(d=>d.run_id === run.id);
    const count=status=>rows.filter(d=>d.status === status).length;
    return { ...run, category:run.category || 'legacy', legacy:!run.category, master_count:count('accepted'), selected:rows.length, accepted:count('accepted'),
      failed:count('failed'), pending:count('pending'), skipped:count('skipped'),
      telegram:rows.filter(d=>d.status === 'accepted' && d.channel === 'telegram').length,
      sms:rows.filter(d=>d.status === 'accepted' && d.channel === 'sms').length, deliveries:rows };
  });
}

// Кому по этой заявке уже ушёл платный лид (по списанию lead_charge) — им повторно не платят и не шлют.
async function getChargedMasterIds(orderId) {
  const { rows } = await pool.query("SELECT master_id FROM balance_transactions WHERE order_id = $1 AND reason = 'lead_charge'", [orderId]);
  return new Set(rows.map((row) => row.master_id));
}

async function addTargetCategories(token, categories) {
  return pool.withTransaction(async client=>{
    const existing=(await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE',[token])).rows[0];
    if(!existing || !['new','pending_review'].includes(existing.status)) return null;
    const merged=[...new Set([...(Array.isArray(existing.target_categories) ? existing.target_categories : []),...categories])];
    if(existing.requirements?.configured && categories.some(c=>!existing.target_categories.includes(c))) throw new Error('Услуга не входит в потребности заявки');
    return (await client.query("UPDATE orders SET target_categories=$1,status='new' WHERE token=$2 RETURNING *",[merged,token])).rows[0];
  });
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
  const price=await settingsService.getLeadPriceTetri(), groups=await require('./category.service').groups();
  const counts=[];
  for(const category of Object.keys(groups)) {
    const recipients=await getDispatchRecipients(category,'',price,isTechnical);
    if(category === 'transport') {
      const sizes=new Map();
      recipients.forEach(m=>{const size=m.services.find(s=>s.service_type === 'van')?.attributes?.size || null; sizes.set(size,(sizes.get(size)||0)+1);});
      for(const [vehicle_size,count] of sizes) counts.push({category,vehicle_size,count});
    } else counts.push({category,vehicle_size:null,count:recipients.length});
  }
  return counts;
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
  const contacts=(await pool.query('SELECT master_id,event_type FROM order_views WHERE order_id=$1',[orderId])).rows;
  stats.contacted=new Set(contacts.filter(e=>['call','whatsapp'].includes(e.event_type)).map(e=>e.master_id)).size;
  return stats;
}

// Cohorts describe the services offered at delivery, not the purpose of a contact click.
// A provider may belong to several cohorts; overall contacted remains a unique union.
// Old records without a snapshot use charge evidence or the sole historical group.
// Never infer historical service attribution from today's provider profile.
async function getOrderFunnelByCategory(orderId) {
  const [dispatched, delivered, charged, events, evidence] = await Promise.all([
    pool.query('SELECT category FROM order_dispatches WHERE order_id = $1 ORDER BY dispatched_at', [orderId]),
    pool.query(
      `SELECT m.id AS master_id, m.category, dd.matched_categories FROM dispatch_deliveries dd
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
    pool.query("SELECT master_id,metadata FROM sms_consent_logs WHERE order_id=$1 AND event_type='LEAD_CHARGE_ACCEPTED'",[orderId]),
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
  dispatched.rows.forEach((row) => groupFor(row.category));
  const historicalGroups=[...new Set(dispatched.rows.map(r=>r.category))];
  const sold=new Map(evidence.rows.map(r=>[r.master_id,r.metadata]));
  const historicalCategories=id=>{
    const metadata=sold.get(id);
    if(Array.isArray(metadata?.matched_categories) && metadata.matched_categories.length)return metadata.matched_categories;
    if(metadata?.category)return [metadata.category];
    return historicalGroups.length === 1 ? historicalGroups : ['legacy'];
  };
  const cohorts=new Map();
  delivered.rows.forEach(row=>{
    const cats=Array.isArray(row.matched_categories) && row.matched_categories.length ? row.matched_categories : historicalCategories(row.master_id);
    const existing=cohorts.get(row.master_id) || new Set();
    cats.forEach(c=>existing.add(c)); cohorts.set(row.master_id,existing);
  });
  charged.rows.forEach(row=>{if(!cohorts.has(row.master_id))cohorts.set(row.master_id,new Set(historicalCategories(row.master_id)));});
  for(const [id,cats] of cohorts) for(const category of cats) groupFor(category).received.add(id);
  events.rows.forEach(row=>{
    if(EVENT_TYPES.includes(row.event_type)) for(const category of cohorts.get(row.master_id) || []) groupFor(category)[row.event_type].add(row.master_id);
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
// language: '' — все исполнители группы, иначе только отметившие этот язык при регистрации.
async function getDispatchRecipients(category, vehicleSize, leadPrice, isTechnical = false, language = '', order = null) {
  const catalog = require('./category.service');
  const definition = await catalog.get(category);
  if (!definition?.is_active) return [];
  const rates = await billing.pricing();
  if (rates.leadPriceTetri !== leadPrice) return [];
  const allowed = await billing.eligibleIds(rates);
  const rows=(await pool.query('SELECT * FROM masters WHERE is_technical=$1 AND is_active=true AND is_subscribed=true AND is_banned=false AND balance_tetri >= $2', [isTechnical,leadPrice])).rows;
  const closed=order ? await getClosedCategories(order.id) : [];
  const open=[...new Set([...(Array.isArray(order?.target_categories) ? order.target_categories : []),category])].filter(c=>!closed.includes(c));
  if(!open.includes(category)) return [];
  const result=[];
  const active=new Set((await catalog.list()).filter(d=>d.is_active).map(d=>d.slug));
  const allServices=(await pool.query('SELECT * FROM master_services')).rows;
  for(const master of rows) {
    if(!allowed.has(master.id) || (master.subscription_until && new Date(master.subscription_until)<=new Date()) || (language && !speaks(master,language))) continue;
    const services=(await matching.servicesFor(master,pool,allServices.filter(s=>s.master_id === master.id))).filter(s=>active.has(s.service_type));
    const size=vehicleSize || (category === 'transport' ? order?.requirements?.transport_size : '') || '';
    if(!matching.matches(services,category,size,open,order?.requirements)) continue;
    if(!definition.is_builtin && catalog.validate(definition,services.find(s=>s.service_type === definition.slug)?.attributes).errors.length) continue;
    result.push({...master,services,matched_categories:open.filter(c=>matching.matches(services,c,c==='transport' ? order?.requirements?.transport_size || '' : '',open,order?.requirements))});
  }
  return result;
}

async function notifyMasters(order, category, vehicleSize, confirmedPrice = null, language = '', context = {}) {
  if (!order) return 0;
  // Always use persisted routing, never a flag supplied by a caller or old preview.
  order = await getOrderByToken(order.token);
  if (!order || !['pending_review', 'new'].includes(order.status)) return 0;
  if(!order.requirements?.configured && !(Array.isArray(order.target_categories) && order.target_categories.includes(category))) order=await addTargetCategories(order.token,[category]);
  if(!order) return 0;
  const isTechnical = order.is_technical === true;
  const telegramService = require('./telegram.service');
  const leadPrice = confirmedPrice ?? await settingsService.getLeadPriceTetri();
  const lowBalanceNudgeTetri = leadPrice * LOW_BALANCE_NUDGE_LEADS;
  const received = await getChargedMasterIds(order.id);
  const unresolved=new Set((await pool.query("SELECT master_id FROM dispatch_deliveries WHERE order_id=$1 AND status='pending'",[order.id])).rows.map(d=>d.master_id));
  const candidates = await getDispatchRecipients(category, vehicleSize, leadPrice, isTechnical, language, order);
  let masters = candidates.filter(m=>!received.has(m.id) && !unresolved.has(m.id) && (!context.recipientIds || context.recipientIds.includes(m.id)));
  if(context.preparedRun) masters=(await pool.query('SELECT * FROM masters')).rows.filter(m=>context.recipientIds.includes(m.id));
  const run = context.preparedRun || await pool.withTransaction(async client=>{
    const created=(await client.query('INSERT INTO dispatch_runs(order_id,category,vehicle_size,language,initiated_by,revision) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [order.id,category,vehicleSize || '',language,context.actor || null,order.revision_version || 0])).rows[0];
    for (const master of masters) await client.query('INSERT INTO dispatch_deliveries(run_id,order_id,master_id,manager_id,matched_categories,service_snapshot) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [created.id,order.id,master.id,master.manager_id,JSON.stringify(master.matched_categories),JSON.stringify(master.services)]);
    return created;
  });
  context.runId=run.id;
  const notifiedIds = [];
  // A row lock serializes routing changes against delivery and charging. Limit
  // concurrency so background SMS auditing can still obtain a pool connection.
  for (let offset = 0; offset < masters.length; offset += 4) {
   await Promise.all(masters.slice(offset, offset + 4).map(async candidate => {
    let outcome = 'skipped';
    let attempted = false;
    let skipReason = 'eligibility_changed';
    try { await technical.withMaster(candidate.id, isTechnical, async (master, client) => {
      const live = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [order.id])).rows[0];
      if (!live || !['pending_review','new'].includes(live.status) || !master.is_active || master.is_banned || !master.is_subscribed ||
          (master.subscription_until && new Date(master.subscription_until) <= new Date()) || master.balance_tetri < leadPrice) return;
      const closed = await client.query('SELECT category FROM order_category_closures WHERE order_id=$1 AND category=$2', [order.id, category]);
      if (closed.rows.length) { skipReason='need_closed'; return; }
      const openMatches=await matching.openMatches(master,live,client);
      const liveServices=await matching.servicesFor(master,client);
      if (!openMatches.includes(category) || !matching.matches(liveServices,category,vehicleSize || (category === 'transport' ? live.requirements?.transport_size : '') || '',openMatches,live.requirements)) { skipReason='service_changed'; return; }
      if (language && !speaks(master,language)) { skipReason='language_changed'; return; }
      await client.query('UPDATE dispatch_deliveries SET matched_categories=$3::jsonb,service_snapshot=$4::jsonb WHERE run_id=$1 AND master_id=$2',[run.id,master.id,JSON.stringify(openMatches),JSON.stringify(liveServices)]);
      // The master lock serializes concurrent attempts, including direct retries
      // that bypass the dispatch UI. One order can charge this provider once.
      const charged = await client.query("SELECT id FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge' LIMIT 1", [master.id, order.id]);
      if (charged.rows.length) { skipReason='already_received'; return; }
      const earlier=(await client.query("SELECT id FROM dispatch_deliveries WHERE order_id=$1 AND master_id=$2 AND status='pending' AND run_id < $3",[order.id,master.id,run.id])).rows;
      if(earlier.length) { skipReason='prior_attempt_pending'; return; }
      const rates = await billing.pricing(client, true);
      const billingConsent = await billing.accepted(master.id, rates, client);
      if (!billingConsent || rates.leadPriceTetri !== leadPrice) return;
      const link = getBaseUrl() + '/order/' + order.token + '?master=' + master.id;
      let receipt = null;
      attempted = true;
      let channel = 'telegram';
      if (master.telegram_id) receipt = await telegramService.sendLeadToMaster({...master,matched_categories:openMatches}, order, link).catch(() => ({ok:false,uncertain:true}));
      if (!receipt?.ok && !receipt?.uncertain) {
        channel = 'sms';
        try {
          receipt = await smsService.sendOrderNotification(master.phone, serviceMessage.sms('lead', { test: isTechnical ? '[TEST] ' : '', id: order.id, link }),
            { kind: 'lead', masterId: master.id, orderId: order.id });
        } catch (err) { receipt = {ok:false,uncertain:err.deliveryUnknown !== false}; console.error('Failed to notify master ' + master.id + ':', err.message); }
      }
      const delivered = receipt?.ok === true;
      outcome = delivered ? 'accepted' : receipt?.uncertain ? 'pending' : 'failed';
      if (delivered) {
        // Evidence and debit commit together. A failed audit means no charge.
        const charges = await masterService.chargeMastersForLead([master.id], leadPrice, order.id, client);
        await consentLog.recordAction({ eventType: 'LEAD_CHARGE_ACCEPTED', phone: master.phone,
          masterId: master.id, orderId: order.id, metadata: {
            balance_transaction_id: charges[0].id,
            billing_consent_log_id: billingConsent.consent_log_id, pricing_key: rates.key,
            run_id: run.id, category, matched_categories: openMatches, service_snapshot: liveServices, amount_tetri: leadPrice, balance_before_tetri: master.balance_tetri,
            balance_after_tetri: master.balance_tetri - leadPrice, channel,
            provider_message_id: receipt.providerMessageId || null,
            provider_response: receipt.providerResponse || null, message_body: receipt.messageBody || null,
            acceptance_status: 'accepted', delivery_status: 'unknown',
          } }, client);
      }
      await client.query('UPDATE dispatch_deliveries SET status=$3,channel=$4,reason=$5,finished_at=NOW() WHERE run_id=$1 AND master_id=$2', [run.id,master.id,outcome,channel,delivered ? null : receipt?.uncertain ? 'result_unknown' : 'channel_rejected']);
    }); } catch(error) {
      // A provider may already have accepted a message before a transaction failed.
      // Leave uncertain attempts pending: they must never be blindly retried.
      outcome = attempted ? 'pending' : 'failed';
      await pool.query('UPDATE dispatch_deliveries SET status=$3,reason=$4 WHERE run_id=$1 AND master_id=$2',[run.id,candidate.id,outcome,attempted ? 'result_unknown' : 'before_send_error']);
      console.error('Dispatch recipient failed:',candidate.id,error.message);
    }
    if (outcome === 'accepted') {
      notifiedIds.push(candidate.id);
      if (candidate.balance_tetri >= lowBalanceNudgeTetri && candidate.balance_tetri - leadPrice < lowBalanceNudgeTetri)
        await nudgeLowBalance({ ...candidate, is_technical: isTechnical, balance_tetri: candidate.balance_tetri - leadPrice }, telegramService, 'low').catch(err => console.error('Low balance reminder failed:', err.message));
    }
    if (outcome === 'skipped') await pool.query("UPDATE dispatch_deliveries SET status='skipped',reason=$3,finished_at=NOW() WHERE run_id=$1 AND master_id=$2", [run.id,candidate.id,skipReason]);
   }));
  }
  const { activeWhere, catParams, catClause } = dispatchFilter(category, vehicleSize, isTechnical);
  // Прежние отправки этой же группы (другой язык): кого они уже учли, тому «упущенный лид» второй раз не засчитываем.
  const { rows: earlier } = await pool.query('SELECT language FROM order_dispatches WHERE order_id = $1 AND category = $2 AND vehicle_size = $3 AND language <> $4', [order.id, category, vehicleSize || '', language || '']);
  const { rows: broke } = await pool.query('SELECT * FROM masters WHERE ' + activeWhere + ' AND balance_tetri < $1', [leadPrice]);
  for (const candidate of broke) {
    if (notifiedIds.includes(candidate.id)) continue;
    if (!(await matching.openMatches(candidate,await getOrderByToken(order.token))).includes(category)) continue;
    if(!matching.matches(await matching.servicesFor(candidate),category,vehicleSize || '',order.target_categories,order.requirements)) continue;
    // Рассылка по языку не касается тех, кто на нём не говорит.
    if (language && !speaks(candidate, language)) continue;
    if (earlier.some((e) => !e.language || speaks(candidate, e.language))) continue;
    await technical.withMaster(candidate.id, isTechnical, async (master, client) => {
      if (!master.is_active || master.is_banned || !master.is_subscribed || master.balance_tetri >= leadPrice) return;
      if (!await billing.accepted(master.id, await billing.pricing(client), client)) return;
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
  getCustomerLanguage,
  getDispatchRecipients,
  createPendingOrder,
  activateOrder,
  getOrderByToken,
  getOrderByOwnerToken,
  getOrdersByTokens,
  addTargetCategories,
  recordDispatch,
  getChargedMasterIds,
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
