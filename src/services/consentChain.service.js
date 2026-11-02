const crypto = require('crypto');
const pool = require('../config/db');

// Проверяемая целостность журнала согласий (sms_consent_logs). Триггеры запрещают менять и удалять записи, но
// владелец базы может их снять. Поэтому каждая запись по порядку получает звено цепочки (consent_log_chain):
// SHA-256 от отпечатка предыдущего звена и однозначного текста самой записи. Изменённая или удалённая запись
// ломает все звенья после неё. Раз в сутки отпечаток последнего звена уходит в Telegram модератора
// (consent_log_anchors): копия вне базы, по которой видно, что журнал с того дня не меняли.
// Цепочку ведёт фоновая задача, а не триггер на вставку: регистрации и рассылке не приходится ждать друг друга.
const GENESIS = 'genesis';
const SETTLE_MS = 60 * 1000; // записи моложе минуты ждут: их транзакция могла ещё не завершиться
const BATCH = 500;
const EXTEND_EVERY_MS = 5 * 60 * 1000;
const ANCHOR_EVERY_MS = 24 * 60 * 60 * 1000;

// Однозначный текст записи: ключи по алфавиту на всех уровнях, время — ISO в UTC, числа — строкой (драйвер
// отдаёт BIGINT строкой, тестовая база — числом; отпечаток от этого зависеть не должен).
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (typeof value === 'number' || typeof value === 'bigint') return JSON.stringify(String(value));
  return JSON.stringify(value);
}

function link(prev, row) {
  return crypto.createHash('sha256').update(prev + '|' + canonical(row), 'utf8').digest('hex');
}

// Добавить в цепочку записи журнала, которых в ней ещё нет, по возрастанию id.
async function extend({ settleMs = SETTLE_MS } = {}) {
  const cutoff = new Date(Date.now() - settleMs);
  let added = 0;
  for (;;) {
    const batch = await pool.withTransaction(async (client) => {
      const last = (await client.query('SELECT row_hash FROM consent_log_chain ORDER BY seq DESC LIMIT 1')).rows[0];
      let prev = last ? last.row_hash : GENESIS;
      const rows = (await client.query(`SELECT l.* FROM sms_consent_logs l LEFT JOIN consent_log_chain c ON c.log_id = l.id
        WHERE c.log_id IS NULL AND l.timestamp_utc < $1 ORDER BY l.id LIMIT ${BATCH}`, [cutoff])).rows;
      for (const row of rows) {
        const hash = link(prev, row);
        await client.query('INSERT INTO consent_log_chain(log_id, prev_hash, row_hash) VALUES($1,$2,$3)', [row.id, prev, hash]);
        prev = hash;
      }
      return rows.length;
    });
    added += batch;
    if (batch < BATCH) return added;
  }
}

// Пересчитать цепочку по журналу: каждое звено на месте, записи не изменены и не удалены, отпечатки, отправленные
// в Telegram, совпадают с цепочкой. Ничего не меняет.
async function verify() {
  const links = (await pool.query('SELECT seq, log_id, prev_hash, row_hash FROM consent_log_chain ORDER BY seq')).rows;
  const problems = [];
  let prev = GENESIS;
  for (let i = 0; i < links.length; i += BATCH) {
    const part = links.slice(i, i + BATCH);
    const ph = part.map((_, index) => `$${index + 1}`).join(', ');
    const rows = new Map((await pool.query(`SELECT * FROM sms_consent_logs WHERE id IN (${ph})`, part.map((item) => item.log_id))).rows
      .map((row) => [String(row.id), row]));
    for (const item of part) {
      const row = rows.get(String(item.log_id));
      if (item.prev_hash !== prev) problems.push({ seq: Number(item.seq), log_id: Number(item.log_id), problem: 'нарушен порядок звеньев' });
      if (!row) problems.push({ seq: Number(item.seq), log_id: Number(item.log_id), problem: 'запись журнала удалена' });
      else if (link(item.prev_hash, row) !== item.row_hash) problems.push({ seq: Number(item.seq), log_id: Number(item.log_id), problem: 'запись журнала изменена' });
      prev = item.row_hash;
    }
  }
  const bySeq = new Map(links.map((item) => [String(item.seq), item.row_hash]));
  const anchors = (await pool.query('SELECT id, chain_seq, chain_head, created_at FROM consent_log_anchors ORDER BY id')).rows;
  for (const anchor of anchors) {
    if (bySeq.get(String(anchor.chain_seq)) !== anchor.chain_head) problems.push({ anchor: Number(anchor.id), problem: 'цепочка не совпадает с отпечатком от ' + new Date(anchor.created_at).toISOString() });
  }
  const unchained = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM sms_consent_logs l LEFT JOIN consent_log_chain c ON c.log_id = l.id
    WHERE c.log_id IS NULL AND l.timestamp_utc < $1`, [new Date(Date.now() - SETTLE_MS)])).rows[0].n);
  return { ok: problems.length === 0, checked: links.length, anchors: anchors.length, unchained, head: prev, problems: problems.slice(0, 50) };
}

// Отпечаток дня: дописать цепочку, отправить последнее звено в Telegram модератора и сохранить.
async function anchor() {
  await extend();
  const head = (await pool.query('SELECT seq, log_id, row_hash FROM consent_log_chain ORDER BY seq DESC LIMIT 1')).rows[0];
  if (!head) return null;
  const total = Number((await pool.query('SELECT COUNT(*)::int AS n FROM sms_consent_logs')).rows[0].n);
  const day = new Date().toISOString().slice(0, 10);
  const text = `Журнал согласий Xtender, отпечаток на ${day}: записей ${total}, звено ${head.seq} (запись #${head.log_id}).\n${head.row_hash}\n`
    + 'Не удаляйте это сообщение: по нему можно доказать, что журнал с этого дня не меняли.';
  let sentTo = null;
  try {
    const telegram = require('./telegram.service');
    if (process.env.TELEGRAM_MODERATOR_CHAT_ID) { await telegram.sendSecurityAlert(text); sentTo = 'telegram'; }
  } catch (error) {
    console.error('[consent-chain] anchor message failed:', error.message);
  }
  await pool.query('INSERT INTO consent_log_anchors(chain_seq, log_id, chain_head, log_rows, sent_to) VALUES($1,$2,$3,$4,$5)',
    [head.seq, head.log_id, head.row_hash, total, sentTo]);
  return { seq: Number(head.seq), logId: Number(head.log_id), head: head.row_hash, total, sentTo };
}

// Для страницы согласий: без пересчёта, только размер цепочки и последний отпечаток.
async function status() {
  const [chain, anchor, logs] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM consent_log_chain'),
    pool.query('SELECT chain_seq, chain_head, log_rows, sent_to, created_at FROM consent_log_anchors ORDER BY id DESC LIMIT 1'),
    pool.query('SELECT COUNT(*)::int AS n FROM sms_consent_logs'),
  ]);
  return { chained: Number(chain.rows[0].n), logs: Number(logs.rows[0].n), lastAnchor: anchor.rows[0] || null };
}

function start() {
  const grow = () => extend().catch((error) => console.error('[consent-chain] extend:', error.message));
  const daily = async () => {
    const last = (await pool.query('SELECT created_at FROM consent_log_anchors ORDER BY id DESC LIMIT 1')).rows[0];
    if (!last || Date.now() - new Date(last.created_at).getTime() >= ANCHOR_EVERY_MS) await anchor();
  };
  setTimeout(grow, 30 * 1000).unref();
  setInterval(grow, EXTEND_EVERY_MS).unref();
  setInterval(() => daily().catch((error) => console.error('[consent-chain] anchor:', error.message)), 60 * 60 * 1000).unref();
  setTimeout(() => daily().catch((error) => console.error('[consent-chain] anchor:', error.message)), 2 * 60 * 1000).unref();
}

module.exports = { canonical, extend, verify, anchor, status, start, GENESIS };
