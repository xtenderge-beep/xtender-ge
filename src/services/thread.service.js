// Личная переписка заказчика с каждым исполнителем по заявке (ТЗ, раздел 7; уточнение 3: переписка работает вместе с
// режимом «сначала предложения»). Одна ветка на пару заявка + исполнитель (UNIQUE). Начинает ветку исполнитель;
// заказчик видит все свои ветки и отвечает в них; исполнитель — только свою. Вопросы и предложения конкурентов другим
// исполнителям не видны. Номера телефонов в сообщениях исполнителя скрыты, как в описании профиля.
const crypto = require('node:crypto');
const pool = require('../config/db');
const deal = require('../config/deal');
const tenders = require('./tender.service');
const outbox = require('./outbox.service');
const access = require('./orderAccess.service');

const { DealError } = deal;
const newId = (prefix) => prefix + crypto.randomBytes(10).toString('hex');
const notFound = () => new DealError(404, 'NOT_FOUND', 'The thread does not exist or is not accessible to this account.');

function assertOpen(order) {
  if (!['offers', 'both'].includes(order.response_mode)) throw new DealError(409, 'MESSAGES_NOT_AVAILABLE', 'Messages are available for requests that take written offers.');
  if (tenders.publication(order) !== 'published') throw new DealError(409, 'IN_REVIEW', 'The request is still in moderator review.');
  if (!tenders.acceptsMessages(order)) throw new DealError(409, 'ACTION_NOT_ALLOWED', 'The request is closed for messages.');
}

async function forProvider(client, order, master, { create = false } = {}) {
  if (!master || !(await access.has(order.id, master.id, client))) throw tenders.notFound();
  let thread = (await client.query('SELECT * FROM order_threads WHERE order_id=$1 AND master_id=$2', [order.id, master.id])).rows[0];
  if (!thread && create) {
    await client.query('INSERT INTO order_threads (id, order_id, master_id) VALUES ($1,$2,$3) ON CONFLICT (order_id, master_id) DO NOTHING', [newId('thr_'), order.id, master.id]);
    thread = (await client.query('SELECT * FROM order_threads WHERE order_id=$1 AND master_id=$2', [order.id, master.id])).rows[0];
  }
  return thread || null;
}

async function byId(threadId, client = pool) {
  return (await client.query('SELECT * FROM order_threads WHERE id=$1', [String(threadId || '')])).rows[0] || null;
}

// Ветка для зрителя: заказчик своей заявки (аккаунт API или владелец по ссылке /o/) или исполнитель — своя ветка.
async function forViewer(viewer, threadId) {
  const thread = await byId(threadId);
  if (!thread) throw notFound();
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [thread.order_id])).rows[0];
  if (viewer.master && thread.master_id === viewer.master.id) return { thread, order, role: 'provider' };
  if ((viewer.account && order.account_id === viewer.account.id) || (viewer.ownerOrderId && viewer.ownerOrderId === order.id)) return { thread, order, role: 'customer' };
  throw notFound();
}

async function send(order, thread, role, body, { master = null } = {}) {
  const raw = typeof body === 'string' ? body.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
  if (!raw || raw.length > deal.LIMITS.message) throw new DealError(422, 'VALIDATION_FAILED', `The message must be 1–${deal.LIMITS.message} characters.`, { fields: [{ path: 'text', code: 'INVALID_LENGTH' }] });
  const text = role === 'provider' ? require('../config/phoneInText').maskPhones(raw) : raw;
  return pool.withTransaction(async (client) => {
    const live = await tenders.lockById(client, order.id);
    assertOpen(live);
    let current = thread;
    if (!current) {
      if (role !== 'provider') throw notFound();
      current = await forProvider(client, live, master, { create: true });
    }
    // Тот же текст того же автора за последние 2 минуты — повтор (двойное нажатие, повтор запроса ассистентом), не
    // новое сообщение: возвращаем прежнее, второго уведомления нет.
    const recent = (await client.query('SELECT * FROM order_messages WHERE thread_id=$1 AND author_role=$2 AND body=$3 AND created_at > $4 ORDER BY created_at DESC LIMIT 1',
      [current.id, role, text, new Date(Date.now() - 2 * 60 * 1000)])).rows[0];
    if (recent) return { thread: current, message: recent, repeated: true };
    const message = (await client.query('INSERT INTO order_messages (id, thread_id, author_role, body) VALUES ($1,$2,$3,$4) RETURNING *',
      [newId('msg_'), current.id, role, text])).rows[0];
    await client.query(`UPDATE order_threads SET last_message_at = NOW(), ${role === 'provider' ? 'provider_seen_at' : 'customer_seen_at'} = NOW() WHERE id = $1`, [current.id]);
    await client.query('UPDATE orders SET deal_updated_at = NOW() WHERE id = $1', [live.id]);
    await outbox.emit(client, 'message.created', live.id, { thread_id: current.id, message_id: message.id, author_role: role, master_id: current.master_id }, `message.created:${message.id}`);
    return { thread: current, message };
  });
}

async function messages(thread, { limit = 50, before = null, markSeenBy = null } = {}) {
  const rows = (await pool.query('SELECT * FROM order_messages WHERE thread_id=$1 ORDER BY created_at, id', [thread.id])).rows;
  if (markSeenBy) await pool.query(`UPDATE order_threads SET ${markSeenBy === 'provider' ? 'provider_seen_at' : 'customer_seen_at'} = NOW() WHERE id = $1`, [thread.id]);
  const list = before ? rows.filter((m) => m.id !== before && new Date(m.created_at) <= new Date((rows.find((r) => r.id === before) || {}).created_at || 0)) : rows;
  return list.slice(-limit);
}

function messageView(m) {
  return { id: m.id, thread_id: m.thread_id, author_role: m.author_role, text: m.body, created_at: deal.iso(m.created_at) };
}

async function threadView(thread, role, client = pool) {
  const last = (await client.query('SELECT * FROM order_messages WHERE thread_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [thread.id])).rows[0];
  const seen = role === 'customer' ? thread.customer_seen_at : thread.provider_seen_at;
  const other = role === 'customer' ? 'provider' : 'customer';
  const unread = (await client.query('SELECT created_at, author_role FROM order_messages WHERE thread_id=$1', [thread.id])).rows
    .filter((m) => m.author_role === other && (!seen || new Date(m.created_at) > new Date(seen))).length;
  const provider = await require('./offer.service').providerInfo(thread.master_id, client);
  return { id: thread.id, tender_id: 'tnd_' + thread.order_id, provider_id: 'prv_' + thread.master_id, provider_name: provider.display_name,
    created_at: deal.iso(thread.created_at), last_message_at: deal.iso(thread.last_message_at), unread_count: unread, last_message: last ? messageView(last) : null };
}

async function listForOrder(orderId) {
  const rows = (await pool.query('SELECT * FROM order_threads WHERE order_id=$1', [orderId])).rows;
  return rows.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0) || (a.id < b.id ? -1 : 1));
}

module.exports = { forProvider, forViewer, byId, send, messages, messageView, threadView, listForOrder, assertOpen };
