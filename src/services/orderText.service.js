const pool = require('../config/db');
const consentLog = require('./consentLog.service');
const translation = require('./translation.service');

// Правка заявки менеджером после разговора с заказчиком. Два действия с разными правилами:
// edit    — переписать текст. Только до первой рассылки: исполнители, уже получившие и оплатившие
//           заявку, должны видеть её такой, какой получили. Текст заказчика сохраняется в
//           client_description.
// clarify — уточнение отдельным блоком (manager_note). Можно и после рассылки: текст заявки не
//           меняется, исполнитель видит дополнение на странице заявки.
// Оба действия пишутся в журнал заявки (sms_consent_logs, как правка самим заказчиком): кто, когда,
// что было и что стало. Перевод и карточка «Кратко» обновляются в фоне.
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function edit(token, rawText, actor, meta = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (text.length < 10 || text.length > 5000) throw fail('Текст заявки: от 10 до 5000 символов.');
  const order = await pool.withTransaction(async client => {
    const current = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE', [token])).rows[0];
    if (!current) throw fail('Заявка не найдена.', 404);
    if (current.status !== 'pending_review' || current.first_dispatched_at) throw fail('Заявка уже отправлялась исполнителям: текст не переписывается. Добавьте уточнение.', 409);
    if (current.description === text) return null;
    const saved = (await client.query(`UPDATE orders SET description=$2, client_description=COALESCE(client_description,$3),
      description_translations='{}'::jsonb, source_lang=$4, brief=NULL WHERE id=$1 RETURNING *`,
      [current.id, text, current.description, translation.detectLang(text)])).rows[0];
    await consentLog.recordAction({ eventType: 'ORDER_EDITED_BY_MANAGER', phone: current.phone, orderId: current.id,
      metadata: { before: current.description, after: text, actor }, meta }, client);
    return saved;
  });
  if (order) refresh(order);
  return order;
}

async function clarify(token, rawNote, actor, meta = {}) {
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note.length > 2000) throw fail('Уточнение: до 2000 символов.');
  const order = await pool.withTransaction(async client => {
    const current = (await client.query('SELECT * FROM orders WHERE token=$1 FOR UPDATE', [token])).rows[0];
    if (!current) throw fail('Заявка не найдена.', 404);
    if (!['pending_review', 'new'].includes(current.status)) throw fail('Заявка закрыта: уточнение не добавить.', 409);
    if ((current.manager_note || '') === note) return null;
    const saved = (await client.query("UPDATE orders SET manager_note=$2, manager_note_translations='{}'::jsonb, brief=NULL WHERE id=$1 RETURNING *",
      [current.id, note || null])).rows[0];
    await consentLog.recordAction({ eventType: 'ORDER_CLARIFIED_BY_MANAGER', phone: current.phone, orderId: current.id,
      metadata: { before: current.manager_note || '', after: note, actor }, meta }, client);
    return saved;
  });
  if (order) refresh(order);
  return order;
}

// Перевод текста и уточнения, сообщение модераторам и карточка «Кратко» — в фоне: сохранение не
// ждёт внешних сервисов. Результат пишется, только если текст за это время не изменили ещё раз.
function refresh(order) {
  (async () => {
    const text = await translation.translateOrder(order.description);
    if (text) await pool.query('UPDATE orders SET source_lang=$1, description_translations=$2::jsonb WHERE id=$3 AND description=$4',
      [text.sourceLang, JSON.stringify(text.translations), order.id, order.description]);
    if (order.manager_note) {
      const note = await translation.translateOrder(order.manager_note);
      if (note) await pool.query('UPDATE orders SET manager_note_translations=$1::jsonb WHERE id=$2 AND manager_note=$3',
        [JSON.stringify({ ...note.translations, source: note.sourceLang }), order.id, order.manager_note]);
    }
    const fresh = (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
    if (fresh) await require('./telegram.service').updateMessage(fresh);
    await require('./orderBrief.service').refresh(order.id);
  })().catch(error => console.error('Order text refresh failed:', error.message));
}

// Уточнение менеджера по языкам: исходный текст плюс переводы, которые успели прийти.
function noteTexts(order) {
  if (!order?.manager_note) return {};
  const stored = typeof order.manager_note_translations === 'string' ? JSON.parse(order.manager_note_translations) : order.manager_note_translations || {};
  const { source, ...translations } = stored;
  return { ...translations, [source || translation.detectLang(order.manager_note)]: order.manager_note };
}

module.exports = { edit, clarify, noteTexts };
