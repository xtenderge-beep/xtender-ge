const pool = require('../config/db');

// Кто и что сделал с профилем исполнителя из админки или Telegram (таблица
// master_admin_events). Показывается в списке /admin/masters: «Одобрил: …» и
// «Последнее изменение». Сбой записи не отменяет само действие — только лог.

const ADMIN = 'Администратор';

async function record(masterId, { actor = ADMIN, managerId = null, action, body = '' }) {
  try {
    await pool.query('INSERT INTO master_admin_events(master_id,actor,manager_id,action,body) VALUES($1,$2,$3,$4,$5)',
      [masterId, String(actor).slice(0, 120), managerId, action, String(body || '')]);
  } catch (err) { console.error('[master-audit]', masterId, action, err.message); }
}

// Кто нажал кнопку в Telegram: привязанный менеджер — по имени, иначе имя из Telegram.
async function telegramActor(from = {}) {
  const manager = from.id ? await require('./manager.service').getByTelegramId(from.id).catch(() => null) : null;
  if (manager) return { actor: manager.name, managerId: manager.id };
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'модератор';
  return { actor: 'Telegram: ' + name + (from.username ? ' (@' + from.username + ')' : ''), managerId: null };
}

module.exports = { ADMIN, record, telegramActor };
