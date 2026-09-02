const pool = require('../config/db');
const redis = require('../config/redis');
const smsService = require('./sms.service');
const masterService = require('./master.service');
const { getBaseUrl } = require('../config/url');
const { generateShortId } = require('../config/shortId');

const COST_PER_NOTIFICATION_TETRI = 30;
const LOW_BALANCE_NUDGE_TETRI = 150; // ~5 лидов — ниже этого шлём разовый «пополни»
const NUDGE_THROTTLE_SECONDS = 24 * 60 * 60;

// Разовый (не чаще раза в сутки) пинок «пополни баланс» — в Telegram, если привязан,
// иначе SMS. reason: 'low' (списание уронило баланс) | 'missed' (не хватило на лид).
async function nudgeLowBalance(master, telegramService, reason) {
  const key = `lowbal_nudge:${master.id}`;
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

async function createPendingOrder({ phone, description, districtName }) {
  const token = generateShortId();
  const ownerToken = generateShortId();
  const { rows } = await pool.query(
    `INSERT INTO orders (phone, description, district_name, token, owner_token, target_categories, status)
     VALUES ($1, $2, $3, $4, $5, '{}', 'unverified') RETURNING *`,
    [phone, description, districtName, token, ownerToken]
  );
  return rows[0];
}

async function getOrderByOwnerToken(ownerToken) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE owner_token = $1', [ownerToken]);
  return rows[0] || null;
}

async function activateOrder(token, phone) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'pending_review'
     WHERE token = $1 AND phone = $2 AND status = 'unverified' RETURNING *`,
    [token, phone]
  );
  return rows[0] || null;
}

async function setModerationMessageId(orderId, messageId) {
  await pool.query('UPDATE orders SET moderation_message_id = $1 WHERE id = $2', [messageId, orderId]);
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

async function recordDispatch(orderId, category, vehicleSize) {
  try {
    await pool.query(
      `INSERT INTO order_dispatches (order_id, category, vehicle_size) VALUES ($1, $2, $3)`,
      [orderId, category, vehicleSize || '']
    );
    return true;
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

  const counts = await getMasterCountsByCategory();
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

async function closeOrder(token) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'closed', closed_at = NOW()
     WHERE token = $1 AND status != 'closed' RETURNING *`,
    [token]
  );
  return rows[0] || null;
}

async function getMasterCountsByCategory() {
  const { rows } = await pool.query(
    `SELECT category, vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
     GROUP BY category, vehicle_size
     UNION ALL
     SELECT 'flatbed' AS category, NULL AS vehicle_size, COUNT(*)::int AS count
     FROM masters
     WHERE is_active = true AND is_subscribed = true AND is_banned = false AND balance_tetri >= $1
       AND (subscription_until IS NULL OR subscription_until > NOW())
       AND category = 'transport' AND is_flatbed = true`,
    [COST_PER_NOTIFICATION_TETRI]
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

async function notifyMasters(order, category, vehicleSize) {
  // Ленивый require — telegram.service требует этот модуль на верхнем уровне,
  // прямой require здесь замкнул бы цикл на этапе загрузки.
  const telegramService = require('./telegram.service');

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
  const activeWhere = `is_active = true AND is_subscribed = true AND is_banned = false
                       AND (subscription_until IS NULL OR subscription_until > NOW())`;

  const { rows: masters } = await pool.query(
    `SELECT id, phone, telegram_id, master_token, balance_tetri FROM masters
     WHERE ${activeWhere} AND balance_tetri >= $1${catClause}`,
    [COST_PER_NOTIFICATION_TETRI, ...catParams]
  );
  const base = getBaseUrl();

  const notifiedIds = [];
  await Promise.all(
    masters.map(async (master) => {
      const link = `${base}/order/${order.token}?master=${master.id}`;

      // Привязан Telegram → шлём в бот; при сбое откатываемся на SMS, чтобы лид не пропал.
      let delivered = false;
      if (master.telegram_id) {
        delivered = await telegramService.sendLeadToMaster(master, order, link).catch(() => false);
      }
      if (!delivered) {
        try {
          await smsService.sendOrderNotification(master.phone, `Xtender: new order #${order.id}: ${link}`, {
            kind: 'lead',
            masterId: master.id,
            orderId: order.id,
          });
          delivered = true;
        } catch (err) {
          console.error(`Failed to notify master ${master.id}:`, err.message);
        }
      }
      if (delivered) notifiedIds.push(master.id);
    })
  );

  if (notifiedIds.length) {
    await pool.withTransaction((client) =>
      masterService.chargeMastersForLead(notifiedIds, COST_PER_NOTIFICATION_TETRI, order.id, client)
    );

    // Списание уронило баланс ниже «мало» — разовый пинок «пополни».
    await Promise.all(
      masters
        .filter((m) =>
          notifiedIds.includes(m.id) &&
          m.balance_tetri >= LOW_BALANCE_NUDGE_TETRI &&
          m.balance_tetri - COST_PER_NOTIFICATION_TETRI < LOW_BALANCE_NUDGE_TETRI)
        .map((m) =>
          nudgeLowBalance({ ...m, balance_tetri: m.balance_tetri - COST_PER_NOTIFICATION_TETRI }, telegramService, 'low'))
    );
  }

  // Подходили под рассылку, но денег не хватило — считаем пропуск + разовый пинок.
  const { rows: broke } = await pool.query(
    `SELECT id, phone, telegram_id, master_token, balance_tetri FROM masters
     WHERE ${activeWhere} AND balance_tetri < $1${catClause}`,
    [COST_PER_NOTIFICATION_TETRI, ...catParams]
  );
  if (broke.length) {
    const brokeIds = broke.map((m) => m.id);
    await pool.query(
      `UPDATE masters SET missed_dispatch_count = missed_dispatch_count + 1
       WHERE id IN (${brokeIds.map((_, i) => `$${i + 1}`).join(', ')})`,
      brokeIds
    );
    await Promise.all(broke.map((m) => nudgeLowBalance(m, telegramService, 'missed')));
  }

  return masters.length;
}

async function attachFiles(orderId, files) {
  if (!files || !files.length) return;

  const values = [];
  const placeholders = files
    .map((file, i) => {
      const base = i * 4;
      values.push(orderId, `/uploads/${file.filename}`, file.originalname, file.mimetype);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    })
    .join(', ');

  await pool.query(
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
  recordModerationMessages,
  getModerationMessages,
  closeOrder,
  notifyMasters,
  getMasterCountsByCategory,
  getOrderFunnelStats,
  logView,
  attachFiles,
  getOrderFiles,
};
