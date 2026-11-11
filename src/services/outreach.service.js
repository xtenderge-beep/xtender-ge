// Рассылки исполнителям: черновик со своим текстом каждому получателю → отправка в чат поддержки кабинета, SMS-уведомление
// и Telegram (если привязан) → по каждому получателю видно, что ушло, по какому каналу, открыл ли он сообщение и что
// ответил. Подробно — docs/provider-outreach.md.
const pool = require('../config/db');
const supportService = require('./support.service');
const smsService = require('./sms.service');
const telegramService = require('./telegram.service');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// SMS-шлюз отдаёт не-латинский текст как UCS-2 и уже портил его (service-message-copy.js), поэтому уведомление — латиницей.
const LATIN_SMS = /^[\x20-\x7E\n]+$/;
const TELEGRAM_HEADER = {
  ru: '💬 Сообщение от поддержки Xtender:',
  ka: '💬 შეტყობინება Xtender-ის მხარდაჭერისგან:',
  en: '💬 Message from Xtender support:',
};
const TELEGRAM_FOOTER = {
  ru: 'Ответьте здесь или в кабинете, вкладка «Профиль».',
  ka: 'უპასუხეთ აქ ან კაბინეტში, ჩანართი «პროფილი».',
  en: 'Reply here or in your account, “Profile” tab.',
};
const PAUSE_MS = Number(process.env.OUTREACH_PAUSE_MS ?? 400);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Список номеров параметрами IN ($1, $2, …): ANY($1) с массивом pg-mem (тесты, dev-server) не находит.
const placeholders = list => list.map((_, i) => '$' + (i + 1)).join(', ');

function checkSms(text) {
  const sms = String(text || '').trim();
  if (!sms) throw fail('Напишите текст SMS-уведомления.');
  if (sms.length > 160) throw fail('SMS длиннее 160 знаков.');
  if (!LATIN_SMS.test(sms)) throw fail('SMS — только латиница, цифры и знаки: кириллицу и грузинский шлюз портит.');
  return sms;
}

// Получатели из текста формы: блоки «#<номер исполнителя>» и текст под ним, блоки разделены строкой «---».
function parseRecipients(raw) {
  const items = [];
  const errors = [];
  for (const block of String(raw || '').replace(/\r/g, '').split(/^-{3,}\s*$/m)) {
    const text = block.trim();
    if (!text) continue;
    const match = /^#\s*(\d+)\s*\n([\s\S]+)$/.exec(text);
    if (!match || !match[2].trim()) { errors.push(text.split('\n')[0].slice(0, 60)); continue; }
    if (match[2].trim().length > 2000) { errors.push('#' + match[1] + ': текст длиннее 2000 знаков'); continue; }
    items.push({ masterId: Number(match[1]), body: match[2].trim() });
  }
  return { items, errors };
}

async function create({ title, smsText, recipients }) {
  const name = String(title || '').trim().slice(0, 200);
  if (!name) throw fail('Назовите рассылку.');
  const sms = checkSms(smsText);
  const { items, errors } = parseRecipients(recipients);
  if (errors.length) throw fail('Не разобрал блоки: ' + errors.join('; '));
  if (!items.length) throw fail('Добавьте хотя бы одного получателя: «#номер», под ним текст.');
  const ids = [...new Set(items.map(item => item.masterId))];
  if (ids.length !== items.length) throw fail('Один исполнитель указан дважды.');
  const found = (await pool.query(`SELECT id FROM masters WHERE is_banned = false AND id IN (${placeholders(ids)})`, ids)).rows.map(r => r.id);
  const missing = ids.filter(id => !found.includes(id));
  if (missing.length) throw fail('Нет таких исполнителей или они заблокированы: #' + missing.join(', #'));
  return pool.withTransaction(async client => {
    const campaign = (await client.query('INSERT INTO outreach_campaigns(title, sms_text) VALUES($1, $2) RETURNING *', [name, sms])).rows[0];
    for (const item of items) {
      await client.query('INSERT INTO outreach_messages(campaign_id, master_id, body) VALUES($1, $2, $3)', [campaign.id, item.masterId, item.body]);
    }
    return campaign;
  });
}

async function list() {
  const campaigns = (await pool.query('SELECT * FROM outreach_campaigns ORDER BY id DESC')).rows;
  const result = [];
  for (const campaign of campaigns) result.push({ ...campaign, stats: (await get(campaign.id)).stats });
  return result;
}

// Рассылка с получателями. Ответ — первое сообщение исполнителя в поддержке после отправки ему; считается здесь, а не
// запросом: pg-mem (тесты, dev-server) не умеет коррелированные подзапросы.
async function get(id) {
  const campaign = (await pool.query('SELECT * FROM outreach_campaigns WHERE id = $1', [id])).rows[0];
  if (!campaign) return null;
  const rows = (await pool.query(
    `SELECT o.*, m.name, m.phone, m.language, m.is_active, m.is_banned, m.telegram_id, s.seen_at
     FROM outreach_messages o
     JOIN masters m ON m.id = o.master_id
     LEFT JOIN support_messages s ON s.id = o.support_message_id
     WHERE o.campaign_id = $1 ORDER BY o.id`, [id])).rows;
  const sentIds = rows.filter(r => r.sent_at).map(r => r.master_id);
  const replies = sentIds.length ? (await pool.query(
    `SELECT master_id, body, created_at FROM support_messages WHERE sender = 'master' AND master_id IN (${placeholders(sentIds)}) ORDER BY created_at`,
    sentIds)).rows : [];
  for (const row of rows) {
    row.reply = row.sent_at ? replies.find(r => r.master_id === row.master_id && new Date(r.created_at) >= new Date(row.sent_at)) || null : null;
  }
  const live = rows.filter(r => r.status !== 'skipped');
  const stats = {
    total: live.length,
    draft: live.filter(r => r.status === 'draft').length,
    sent: live.filter(r => r.status === 'sent').length,
    failed: live.filter(r => r.status === 'failed').length,
    skipped: rows.length - live.length,
    smsAccepted: live.filter(r => r.sms_status === 'accepted').length,
    smsFailed: live.filter(r => r.sms_status === 'failed').length,
    telegram: live.filter(r => r.telegram_sent).length,
    seen: live.filter(r => r.seen_at).length,
    replied: live.filter(r => r.reply).length,
  };
  return { campaign, rows, stats };
}

async function draftRow(campaignId, itemId) {
  const row = (await pool.query(
    `SELECT o.* FROM outreach_messages o WHERE o.id = $1 AND o.campaign_id = $2`, [itemId, campaignId])).rows[0];
  if (!row) throw fail('Получатель не найден.', 404);
  if (row.status !== 'draft' && row.status !== 'skipped') throw fail('Сообщение уже отправлено — изменить нельзя.', 409);
  return row;
}

async function updateBody(campaignId, itemId, body) {
  const text = String(body || '').trim();
  if (!text || text.length > 2000) throw fail('Текст сообщения: от 1 до 2000 знаков.');
  await draftRow(campaignId, itemId);
  await pool.query('UPDATE outreach_messages SET body = $1 WHERE id = $2', [text, itemId]);
}

// Убрать из рассылки и вернуть: только до отправки.
async function setSkipped(campaignId, itemId, skipped) {
  await draftRow(campaignId, itemId);
  await pool.query('UPDATE outreach_messages SET status = $1 WHERE id = $2', [skipped ? 'skipped' : 'draft', itemId]);
}

async function updateSms(campaignId, smsText) {
  const sms = checkSms(smsText);
  const { rowCount } = await pool.query('UPDATE outreach_campaigns SET sms_text = $1 WHERE id = $2 AND sent_at IS NULL', [sms, campaignId]);
  if (!rowCount) throw fail('Рассылка уже отправлена — SMS не меняется.', 409);
}

// Пробное SMS на номер администратора — тем же шлюзом и с тем же текстом, что уйдёт исполнителям.
async function sendTest(campaignId, phone) {
  const campaign = (await pool.query('SELECT * FROM outreach_campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) throw fail('Рассылка не найдена.', 404);
  const number = require('../config/phone').toE164(String(phone || '').trim());
  if (!/^\+995\d{9}$/.test(number)) throw fail('Проверьте номер телефона: грузинский, 9 цифр.');
  await smsService.sendOrderNotification(number, campaign.sms_text, { category: 'outreach_test', meta: { extra: { campaign_id: campaign.id } } });
  return number;
}

async function deliver(campaign, row) {
  const master = (await pool.query('SELECT id, phone, language, telegram_id, is_banned FROM masters WHERE id = $1', [row.master_id])).rows[0];
  if (!master || master.is_banned) {
    await pool.query("UPDATE outreach_messages SET status = 'skipped' WHERE id = $1", [row.id]);
    return;
  }
  const message = await supportService.addMessage({ masterId: master.id, sender: 'moderator', body: row.body });
  await pool.query("UPDATE outreach_messages SET status = 'sent', support_message_id = $1, sent_at = $2 WHERE id = $3",
    [message.id, message.created_at, row.id]);
  // Без SMS — сообщение из «Сейчас на сайте» человеку, который и так открыл сайт (with_sms = false).
  let smsStatus = campaign.with_sms === false ? 'off' : 'failed';
  let smsError = null;
  if (smsStatus !== 'off') {
    try {
      await smsService.sendOrderNotification(master.phone, campaign.sms_text,
        { masterId: master.id, category: 'outreach', meta: { extra: { campaign_id: campaign.id } } });
      smsStatus = 'accepted';
    } catch (err) {
      smsError = String(err.message || err).slice(0, 300);
    }
  }
  let telegramSent = false;
  if (master.telegram_id) {
    const lang = TELEGRAM_HEADER[master.language] ? master.language : 'ka';
    try {
      await telegramService.sendToChat(master.telegram_id, `${TELEGRAM_HEADER[lang]}\n${row.body}\n\n${TELEGRAM_FOOTER[lang]}`);
      telegramSent = true;
    } catch (err) { /* кабинет и SMS уже ушли; Telegram — дополнительный канал */ }
  }
  await pool.query('UPDATE outreach_messages SET sms_status = $1, sms_error = $2, telegram_sent = $3 WHERE id = $4',
    [smsStatus, smsError, telegramSent, row.id]);
}

// Отправка всем, кто в черновике. Повторный запуск не отправит дважды: старт занимает строка рассылки (sent_at),
// а каждый получатель уходит один раз (status draft → sent). Возвращает промис хода рассылки.
async function start(campaignId) {
  const claimed = (await pool.query(
    'UPDATE outreach_campaigns SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING *', [campaignId])).rows[0];
  if (!claimed) throw fail('Рассылка уже отправлена или не найдена.', 409);
  const rows = (await pool.query("SELECT * FROM outreach_messages WHERE campaign_id = $1 AND status = 'draft' ORDER BY id", [campaignId])).rows;
  return {
    count: rows.length,
    done: (async () => {
      for (const [index, row] of rows.entries()) {
        try { await deliver(claimed, row); } catch (err) {
          console.error('[outreach]', campaignId, row.master_id, err.message);
          await pool.query("UPDATE outreach_messages SET status = 'failed', sms_error = $1 WHERE id = $2 AND status = 'draft'",
            [String(err.message).slice(0, 300), row.id]).catch(() => {});
        }
        if (index < rows.length - 1 && PAUSE_MS) await sleep(PAUSE_MS);
      }
    })(),
  };
}

// Сообщение одному исполнителю из «Сейчас на сайте»: рассылка на одного получателя, отправляется сразу. SMS — по галочке.
// Отметки «Открыл» и «Ответил» — как у любой рассылки, в «Рассылках».
const DEFAULT_SMS = 'Xtender: you have a message from support. Log in and reply: https://xtender.ge/master#support';
async function sendOne({ masterId, body, withSms = false }) {
  const id = Number(masterId);
  const text = String(body || '').trim();
  if (!text || text.length > 2000) throw fail('Сообщение: от 1 до 2000 знаков.');
  const master = (await pool.query('SELECT id, name, is_banned FROM masters WHERE id = $1', [id])).rows[0];
  if (!master || master.is_banned) throw fail('Нет такого исполнителя или он заблокирован.', 404);
  const when = new Date().toLocaleString('ru', { timeZone: 'Asia/Tbilisi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const campaign = await pool.withTransaction(async client => {
    const row = (await client.query('INSERT INTO outreach_campaigns(title, sms_text, with_sms) VALUES($1, $2, $3) RETURNING *',
      [`Вручную: #${master.id} · ${master.name} · ${when}`.slice(0, 200), DEFAULT_SMS, Boolean(withSms)])).rows[0];
    await client.query('INSERT INTO outreach_messages(campaign_id, master_id, body) VALUES($1, $2, $3)', [row.id, master.id, text]);
    return row;
  });
  const run = await start(campaign.id);
  await run.done;
  return campaign;
}

module.exports = { parseRecipients, create, list, get, updateBody, setSkipped, updateSms, sendTest, start, checkSms, sendOne, DEFAULT_SMS };
