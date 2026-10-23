// Фоновая работа сделки в том же процессе (модульный монолит, ТЗ раздел 17): закрытие сбора по сроку, истечение выбора
// и предложений, обработка очереди событий (outbox → уведомления) и отправка уведомлений. Время берётся с сервера; срок
// сбора при этом проверяют и сами действия (отправка предложения после срока отклоняется, даже если обработчик отстал).
// Перезапуск безопасен: события и уведомления берутся блокировкой с истечением, обработчики идемпотентны.
const pool = require('../config/db');
const outbox = require('./outbox.service');

const INTERVAL_MS = 20 * 1000;
let running = null;
let timer = null;

async function closeExpiredCollections(now) {
  const due = (await pool.query(
    "SELECT id FROM orders WHERE deal_status='open' AND status='new' AND collection_closed_at IS NULL AND submission_deadline IS NOT NULL AND submission_deadline <= $1", [now])).rows;
  for (const row of due) await require('./tender.service').closeCollection(row.id, { actor: 'worker', now });
  return due.length;
}

async function processOutbox(now) {
  const events = await outbox.claim(20, now);
  for (const event of events) {
    let error = null;
    try { await require('./dealNotify.service').handle(event, now); } catch (err) { error = err; }
    const result = await outbox.finish(event, error, now);
    if (result === 'failed') {
      await require('./telegram.service').sendMessageToModerator(`⚠️ Событие ${event.event_type} по заявке #${event.order_id} не обработано после ${event.attempts} попыток: ${String(error && error.message).slice(0, 200)}. Смотрите /admin/outbox.`).catch(() => {});
    }
  }
  return events.length;
}

// Ключи идемпотентности API хранятся 48 часов (обещано «не меньше 24»); чистка — не чаще раза в час.
let lastCleanup = 0;
async function cleanup(now) {
  if (now.getTime() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = now.getTime();
  await pool.query('DELETE FROM api_idempotency_keys WHERE created_at < $1', [new Date(now.getTime() - 48 * 60 * 60 * 1000)]);
}

// Один проход. now — для тестов (истечение сроков без ожидания).
async function runOnce(now = new Date()) {
  const result = {
    closed: await closeExpiredCollections(now),
    selectionsExpired: await require('./selection.service').expireDue(now),
    offersExpired: await require('./offer.service').expireDue(now),
    events: await processOutbox(now),
  };
  result.sent = await require('./dealNotify.service').sendDue(now);
  await cleanup(now);
  return result;
}

// Проход без наложения: если предыдущий ещё идёт, новый ждёт его.
function kick() {
  if (running) return running;
  running = runOnce().catch((err) => console.error('[deal-worker]', err.message)).finally(() => { running = null; });
  return running;
}

function start() {
  if (timer) return;
  timer = setInterval(kick, INTERVAL_MS);
  timer.unref();
  setTimeout(kick, 5000).unref();
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runOnce, kick, start, stop, INTERVAL_MS };
