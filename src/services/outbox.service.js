// Очередь событий сделки (transactional outbox). emit() пишет событие той же транзакцией, что и изменение заявки,
// предложения или выбора, поэтому сбой SMS не теряет предложение, а повторный запрос не публикует заявку второй раз.
// claim()/finish() — для обработчика (deal.worker): строку берёт тот, кто первым выставил locked_until; упавший
// обработчик отпускает её по истечении блокировки, и событие обрабатывается снова (обработчики идемпотентны).
const pool = require('../config/db');

const MAX_ATTEMPTS = 6;
const LOCK_MS = 60 * 1000;
const BACKOFF_MS = [30, 120, 600, 1800, 3600].map((s) => s * 1000);

async function emit(client, eventType, orderId, payload = {}, dedupeKey = null) {
  await client.query(
    'INSERT INTO outbox_events (event_type, order_id, payload, dedupe_key) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (dedupe_key) DO NOTHING',
    [eventType, orderId, JSON.stringify(payload), dedupeKey]);
}

// Повторная проверка условий во внешнем WHERE нужна настоящему Postgres: два обработчика, ждавшие одну строку, после
// снятия блокировки строки перечитывают её, и второй её уже не берёт.
async function claim(limit = 20, now = new Date()) {
  const until = new Date(now.getTime() + LOCK_MS);
  const { rows } = await pool.query(
    `UPDATE outbox_events SET locked_until = $1, attempts = attempts + 1
     WHERE id IN (SELECT id FROM outbox_events
                  WHERE processed_at IS NULL AND failed_at IS NULL AND available_at <= $2 AND (locked_until IS NULL OR locked_until < $2)
                  ORDER BY id LIMIT ${Number(limit)})
       AND processed_at IS NULL AND failed_at IS NULL AND (locked_until IS NULL OR locked_until < $2)
     RETURNING *`, [until, now]);
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

async function finish(event, error = null, now = new Date()) {
  if (!error) {
    await pool.query('UPDATE outbox_events SET processed_at = $2, locked_until = NULL, last_error = NULL WHERE id = $1', [event.id, now]);
    return 'processed';
  }
  const message = String(error.message || error).slice(0, 500);
  if (event.attempts >= MAX_ATTEMPTS) {
    await pool.query('UPDATE outbox_events SET failed_at = $2, locked_until = NULL, last_error = $3 WHERE id = $1', [event.id, now, message]);
    return 'failed';
  }
  const delay = BACKOFF_MS[Math.min(event.attempts - 1, BACKOFF_MS.length - 1)];
  await pool.query('UPDATE outbox_events SET available_at = $2, locked_until = NULL, last_error = $3 WHERE id = $1',
    [event.id, new Date(now.getTime() + delay), message]);
  return 'retry';
}

async function failures(limit = 50) {
  return (await pool.query('SELECT * FROM outbox_events WHERE failed_at IS NOT NULL ORDER BY id DESC LIMIT $1', [limit])).rows;
}

// Повтор из /admin/outbox после исправления причины: событие снова в очереди с нуля попыток.
async function retry(id) {
  const { rows } = await pool.query('UPDATE outbox_events SET failed_at = NULL, attempts = 0, available_at = NOW(), last_error = NULL WHERE id = $1 AND failed_at IS NOT NULL RETURNING id', [id]);
  return Boolean(rows[0]);
}

module.exports = { emit, claim, finish, failures, retry, MAX_ATTEMPTS, LOCK_MS };
