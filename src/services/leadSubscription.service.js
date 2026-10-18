const pool = require('../config/db');
const audit = require('./masterAudit.service');

// Исполнитель сам отказывается от заявок и сам возвращается (masters.is_subscribed). Рассылка таких уже
// пропускает (order.service: getDispatchRecipients, notifyMasters, досылка новым); каталог не меняется —
// заказчик по-прежнему может позвонить ему сам. Кнопка стоит на странице заявки (вход в кабинет или личная
// ссылка из SMS / Telegram) и в кабинете. Кто, когда и откуда — в журнале действий исполнителя
// (master_admin_events), его видно в /admin/masters в «последнем изменении».
const SOURCES = {
  order: 'страница заявки',
  cabinet: 'кабинет',
};

// subscribed — true: снова получать заявки, false: больше не присылать. source — ключ SOURCES;
// orderToken — заявка, со страницы которой нажали (в журнал пишется её номер, как его видит исполнитель).
// Возвращает новое состояние; null — исполнителя нет или он заблокирован (у заблокированного заявок и так нет).
async function set(masterId, subscribed, { source = 'cabinet', orderToken = null } = {}) {
  const master = (await pool.query('SELECT id, is_banned, is_subscribed FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master || master.is_banned) return null;
  const on = subscribed === true;
  if (master.is_subscribed !== on) {
    await pool.query('UPDATE masters SET is_subscribed=$1 WHERE id=$2', [on, masterId]);
    const where = (SOURCES[source] || source) + (orderToken ? ' #' + String(orderToken).slice(0, 6).toUpperCase() : '');
    await audit.record(masterId, {
      actor: 'Исполнитель',
      action: on ? 'leads_on' : 'leads_off',
      body: (on ? 'Снова получает заявки' : 'Отписался от заявок') + ' (' + where + ')',
    });
  }
  return on;
}

// Администратор возвращает исполнителя в рассылку или снимает с неё (по его просьбе по телефону).
async function setByAdmin(masterId, subscribed) {
  const master = (await pool.query('SELECT id, is_subscribed FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master) return null;
  const on = subscribed === true;
  if (master.is_subscribed !== on) {
    await pool.query('UPDATE masters SET is_subscribed=$1 WHERE id=$2', [on, masterId]);
    await audit.record(masterId, { action: on ? 'leads_on' : 'leads_off', body: on ? 'Возвращён в рассылку заявок' : 'Снят с рассылки заявок' });
  }
  return on;
}

module.exports = { set, setByAdmin };
