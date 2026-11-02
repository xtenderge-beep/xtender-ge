const pool = require('../config/db');
const audit = require('./masterAudit.service');
const consentLog = require('./consentLog.service');

// Исполнитель сам отказывается от заявок и сам возвращается (masters.is_subscribed). Рассылка таких уже
// пропускает (order.service: getDispatchRecipients, notifyMasters, досылка новым); каталог не меняется —
// заказчик по-прежнему может позвонить ему сам. Кнопка стоит на странице заявки (вход в кабинет или личная
// ссылка из SMS / Telegram) и в кабинете. Кто, когда и откуда — в журнале действий исполнителя
// (master_admin_events), его видно в /admin/masters в «последнем изменении».
// Каждое изменение пишется и в журнал согласий (sms_consent_logs: LEAD_SMS_OPT_OUT / LEAD_SMS_OPT_IN) в одной
// транзакции с самим изменением: отказ — это отзыв согласия на SMS, его факт и дату закон велит хранить
// (ст. 12(9) закона о персональных данных), а журнал действий изменяемый и удаляется вместе с профилем.
const SOURCES = {
  order: 'страница заявки',
  cabinet: 'кабинет',
};

async function change(masterId, on, { actor, source, orderId = null, meta = {}, allowBanned = false }) {
  return pool.withTransaction(async (client) => {
    const master = (await client.query('SELECT id, phone, is_banned, is_subscribed FROM masters WHERE id=$1 FOR UPDATE', [masterId])).rows[0];
    if (!master || (master.is_banned && !allowBanned)) return null;
    if (master.is_subscribed === on) return { on, changed: false };
    await client.query('UPDATE masters SET is_subscribed=$1 WHERE id=$2', [on, masterId]);
    await consentLog.recordAction({ eventType: on ? 'LEAD_SMS_OPT_IN' : 'LEAD_SMS_OPT_OUT', phone: master.phone, masterId, orderId,
      metadata: { actor, source }, meta }, client);
    return { on, changed: true };
  });
}

// subscribed — true: снова получать заявки, false: больше не присылать. source — ключ SOURCES;
// orderToken — заявка, со страницы которой нажали (в журнал пишется её номер, как его видит исполнитель).
// Возвращает новое состояние; null — исполнителя нет или он заблокирован (у заблокированного заявок и так нет).
async function set(masterId, subscribed, { source = 'cabinet', orderToken = null, orderId = null, meta = {} } = {}) {
  const result = await change(masterId, subscribed === true, { actor: 'provider', source, orderId, meta });
  if (!result) return null;
  if (result.changed) {
    const where = (SOURCES[source] || source) + (orderToken ? ' #' + String(orderToken).slice(0, 6).toUpperCase() : '');
    await audit.record(masterId, {
      actor: 'Исполнитель',
      action: result.on ? 'leads_on' : 'leads_off',
      body: (result.on ? 'Снова получает заявки' : 'Отписался от заявок') + ' (' + where + ')',
    });
  }
  return result.on;
}

// Администратор возвращает исполнителя в рассылку или снимает с неё (по его просьбе по телефону).
async function setByAdmin(masterId, subscribed, { meta = {} } = {}) {
  const result = await change(masterId, subscribed === true, { actor: 'admin', source: 'admin', meta, allowBanned: true });
  if (!result) return null;
  if (result.changed) {
    await audit.record(masterId, { action: result.on ? 'leads_on' : 'leads_off', body: result.on ? 'Возвращён в рассылку заявок' : 'Снят с рассылки заявок' });
  }
  return result.on;
}

module.exports = { set, setByAdmin };
