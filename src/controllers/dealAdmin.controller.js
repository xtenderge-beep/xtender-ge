// /admin/outbox — сбои фоновой работы сделки (docs/api-v1/NOTIFICATIONS.md): события очереди, не обработанные после
// всех попыток, и уведомления со статусом «ошибка» или «неизвестно». «Неизвестно» значит, что шлюз ответил неясно и SMS
// могла уйти: такие сервер сам не повторяет, чтобы не задвоить. Ссылку на эту страницу присылает Telegram модератору.
const pool = require('../config/db');
const outbox = require('../services/outbox.service');

async function index(req, res) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const events = await outbox.failures(100);
  const deliveries = (await pool.query("SELECT * FROM notification_deliveries WHERE status IN ('failed','unknown') AND created_at >= $1 ORDER BY id DESC LIMIT 200", [since])).rows;
  const counts = (await pool.query('SELECT status, COUNT(*)::int AS n FROM notification_deliveries WHERE created_at >= $1 GROUP BY status', [since])).rows;
  const pending = (await pool.query('SELECT COUNT(*)::int AS n FROM outbox_events WHERE processed_at IS NULL AND failed_at IS NULL')).rows[0].n;
  // Ссылки на карточку заявки в админке — по токену заявки.
  const ids = [...new Set([...events, ...deliveries].map((row) => row.order_id).filter(Boolean))];
  const tokens = ids.length ? Object.fromEntries((await pool.query(`SELECT id, token FROM orders WHERE id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})`, ids)).rows.map((row) => [row.id, row.token])) : {};
  res.render('admin/outbox', { events, deliveries, tokens, counts: Object.fromEntries(counts.map((row) => [row.status, row.n])), pending, retried: req.query.retried === '1' });
}

async function retry(req, res) {
  await outbox.retry(Number(req.params.id));
  require('../services/dealWorker.service').kick();
  res.redirect('/admin/outbox?retried=1');
}

module.exports = { index, retry };
