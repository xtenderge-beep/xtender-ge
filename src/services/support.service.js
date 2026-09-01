const pool = require('../config/db');
const telegramService = require('./telegram.service');
const masterService = require('./master.service');

async function addMessage({ masterId, sender, body, tgMessageId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO support_messages (master_id, sender, body, tg_message_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [masterId, sender, body, tgMessageId]
  );
  return rows[0];
}

async function setTgMessageId(id, tgMessageId) {
  await pool.query(`UPDATE support_messages SET tg_message_id = $1 WHERE id = $2`, [tgMessageId, id]);
}

// Последние сообщения треда, по возрастанию — для показа в кабинете.
async function listForMaster(masterId, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, sender, body, created_at FROM (
       SELECT id, sender, body, created_at FROM support_messages
       WHERE master_id = $1 ORDER BY created_at DESC LIMIT $2
     ) t ORDER BY created_at ASC`,
    [masterId, limit]
  );
  return rows;
}

// id последнего сообщения треда в Telegram — чтобы новое переслать как reply на него
// (Telegram сам свяжет их в цепочку).
async function lastThreadTgMessageId(masterId) {
  const { rows } = await pool.query(
    `SELECT tg_message_id FROM support_messages
     WHERE master_id = $1 AND tg_message_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [masterId]
  );
  return rows[0] ? rows[0].tg_message_id : null;
}

// Все треды с последним сообщением — для экрана /admin/support. Без коррелированных
// подзапросов / оконных функций (pg-mem их не тянет): MAX(created_at) на мастера в
// производной таблице, джойн обратно. is_open = последнее сообщение от исполнителя.
async function listThreads() {
  const { rows } = await pool.query(
    `SELECT s.master_id, m.name, m.category, m.telegram_id, s.sender AS last_sender,
            s.body AS last_body, s.created_at AS last_at
     FROM support_messages s
     JOIN (
       SELECT master_id, MAX(created_at) AS last_at
       FROM support_messages GROUP BY master_id
     ) l ON l.master_id = s.master_id AND l.last_at = s.created_at
     JOIN masters m ON m.id = s.master_id
     ORDER BY s.created_at DESC`
  );
  return rows.map((r) => ({ ...r, is_open: r.last_sender === 'master' }));
}

// Треды, ждущие ответа (последнее — от исполнителя).
async function openThreads() {
  return (await listThreads()).filter((t) => t.is_open);
}

async function countOpenThreads() {
  return (await openThreads()).length;
}

// Ответ модератора исполнителю — общий для бота и /admin. Пишет сообщение и, если
// у исполнителя привязан Telegram, пушит туда. Возвращает мастера (или null).
async function postModeratorReply(masterId, body) {
  const master = await masterService.getMasterById(masterId);
  if (!master) return null;
  await addMessage({ masterId, sender: 'moderator', body });
  if (master.telegram_id) {
    await telegramService.sendToChat(
      master.telegram_id,
      `💬 Поддержка ответила:\n${body}\n\nВесь диалог — в кабинете, вкладка «Профиль».`
    );
  }
  return master;
}

// Вопрос исполнителя (из кабинета или боту напрямую) → запись + пересылка модератору
// как reply на предыдущее сообщение треда. Один вход для обоих источников.
async function forwardQuestion(master, body) {
  const row = await addMessage({ masterId: master.id, sender: 'master', body });
  const replyTo = await lastThreadTgMessageId(master.id);
  const tgMessageId = await telegramService.forwardSupportMessage(master, body, replyTo);
  if (tgMessageId) await setTgMessageId(row.id, tgMessageId);
  return row;
}

module.exports = {
  addMessage,
  setTgMessageId,
  listForMaster,
  lastThreadTgMessageId,
  listThreads,
  openThreads,
  countOpenThreads,
  postModeratorReply,
  forwardQuestion,
};
