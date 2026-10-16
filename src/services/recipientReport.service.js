const pool = require('../config/db');

// Отчёт по каждому получателю заявки: как ушло уведомление и что исполнитель сделал потом —
// открыл ссылку, нажал «Позвонить» или WhatsApp. Один исполнитель — одна строка, сколько бы
// отправок по заявке ни было. Общий для экрана заявки (менеджер, админка) и отчёта в Telegram.
//
// Откуда что берётся:
// - доставка — dispatch_deliveries (с 13.09); у более старых рассылок — списание lead_charge;
// - «открыл ссылку» — первое событие view в order_views (пишет скрипт страницы заявки, превью
//   ссылки в мессенджере его не создаёт);
// - «Позвонить» / WhatsApp — первое нажатие, после которого сервер выдал номер (orderContact.service);
// - нажатие, когда номер уже не выдавался (заявка или услуга закрыты), — ORDER_CONTACT_DENIED в журнале.
const RANK = { accepted: 0, pending: 1, failed: 2, skipped: 3 };
// outside — исполнитель открыл заявку или нажал контакт, но в её рассылке не был (вошёл в кабинет
// по пересланной ссылке): номер ему не выдаётся, строка нужна, чтобы такое было видно.
// Порядок строк (решение владельца 2026-10-15): сначала все, кто открыл ссылку или нажал контакт, — кто
// раньше среагировал, тот выше; потом не открывшие — по времени доставки; в конце не получившие.
const ORDER = { contacted: 0, opened: 0, not_opened: 1, pending: 2, not_delivered: 3, skipped: 4, outside: 5 };

async function build(orderId) {
  const [deliveries, charges, events, denied] = await Promise.all([
    pool.query('SELECT master_id, status, channel, reason, created_at, finished_at FROM dispatch_deliveries WHERE order_id = $1 ORDER BY id', [orderId]),
    pool.query("SELECT master_id, created_at FROM balance_transactions WHERE order_id = $1 AND reason = 'lead_charge' ORDER BY id", [orderId]),
    pool.query('SELECT master_id, event_type, viewed_at FROM order_views WHERE order_id = $1', [orderId]),
    // Без «master_id IS NOT NULL» в запросе: pg-mem с ним теряет строки; пустой master_id отсеивается ниже.
    pool.query("SELECT master_id, metadata, timestamp_utc FROM sms_consent_logs WHERE order_id = $1 AND event_type = 'ORDER_CONTACT_DENIED' ORDER BY id", [orderId]),
  ]);
  const people = new Map();
  const person = id => {
    id = Number(id);
    if (!people.has(id)) people.set(id, { master_id: id, name: null, balance_tetri: null, low: false, status: null, channel: null, reason: null, sent_at: null, view: null, call: null, whatsapp: null, denied: {} });
    return people.get(id);
  };
  // Лучший исход среди всех отправок: принятое уведомление важнее пропуска «уже уведомлён».
  for (const d of deliveries.rows) {
    const p = person(d.master_id), rank = RANK[d.status] ?? 9;
    if (p.status == null || rank < (RANK[p.status] ?? 9)) Object.assign(p, { status: d.status, channel: d.channel, reason: d.reason, sent_at: d.finished_at || d.created_at });
  }
  for (const c of charges.rows) {
    const p = person(c.master_id);
    if (p.status == null) Object.assign(p, { status: 'accepted', sent_at: c.created_at });
  }
  for (const e of events.rows) if (['view', 'call', 'whatsapp'].includes(e.event_type)) person(e.master_id)[e.event_type] = e.viewed_at;
  for (const d of denied.rows) {
    if (d.master_id == null) continue;
    const meta = typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata || {};
    const p = person(d.master_id), channel = ['call', 'whatsapp'].includes(meta.channel) ? meta.channel : 'call';
    if (!p[channel] && !p.denied[channel]) p.denied[channel] = { at: d.timestamp_utc, reason: meta.reason || null };
  }
  // Баланс — текущий, не на момент рассылки; low — платный режим и денег меньше цены одной заявки,
  // следующую не получит (в бесплатный период баланс не важен).
  const ids = [...people.keys()], price = await require('./settings.service').getLeadPriceTetri();
  if (ids.length) {
    const { rows } = await pool.query('SELECT id, name, balance_tetri, manager_id, paid_mode FROM masters WHERE id IN (' + ids.map((_, i) => '$' + (i + 1)).join(',') + ')', ids);
    rows.forEach(row => Object.assign(people.get(Number(row.id)), { name: row.name, balance_tetri: row.balance_tetri, low: row.paid_mode === true && row.balance_tetri < price, manager_id: row.manager_id }));
  }
  const rows = [...people.values()].map(p => ({ ...p, outcome: outcome(p) }));
  // Первая реакция — открытие ссылки, а если оно не записалось — первое нажатие контакта.
  const reacted = r => Math.min(time(r.view), time(r.call), time(r.whatsapp));
  rows.sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome] || (ORDER[a.outcome] === 0 ? reacted(a) - reacted(b) : 0) || time(a.sent_at) - time(b.sent_at) || a.master_id - b.master_id);
  const count = test => rows.filter(r => r.outcome !== 'outside' && test(r)).length;
  return {
    rows,
    summary: {
      received: count(r => r.status === 'accepted'),
      opened: count(r => r.view),
      contacted: count(r => r.call || r.whatsapp),
      call: count(r => r.call), whatsapp: count(r => r.whatsapp),
      notOpened: count(r => r.outcome === 'not_opened'),
      pending: count(r => r.outcome === 'pending'),
      failed: count(r => r.outcome === 'not_delivered'),
      denied: count(r => Object.keys(r.denied).length),
      outside: rows.filter(r => r.outcome === 'outside').length,
    },
  };
}

// История исполнителя за последние days дней: сколько заявок получил (списание lead_charge), сколько из
// них открыл и по скольким нажал контакт — когда бы ни открыл. { id: { received, opened, contacted } }.
async function history(masterIds, days = 30) {
  const ids = [...new Set(masterIds.map(Number))];
  const result = Object.fromEntries(ids.map(id => [id, { received: 0, opened: 0, contacted: 0 }]));
  if (!ids.length) return result;
  const list = ids.map((_, i) => '$' + (i + 2)).join(','), since = new Date(Date.now() - days * 86400000);
  const [charges, events] = await Promise.all([
    pool.query("SELECT DISTINCT master_id, order_id FROM balance_transactions WHERE reason = 'lead_charge' AND order_id IS NOT NULL AND created_at >= $1 AND master_id IN (" + list + ')', [since, ...ids]),
    pool.query('SELECT master_id, order_id, event_type FROM order_views WHERE viewed_at >= $1 AND master_id IN (' + list + ')', [since, ...ids]),
  ]);
  const received = new Set(charges.rows.map(row => row.master_id + ':' + row.order_id));
  const opened = new Set(), contacted = new Set();
  for (const row of events.rows) {
    const key = row.master_id + ':' + row.order_id;
    if (!received.has(key)) continue;
    opened.add(key);
    if (row.event_type === 'call' || row.event_type === 'whatsapp') contacted.add(key);
  }
  for (const key of received) result[Number(key.split(':')[0])].received++;
  for (const key of opened) result[Number(key.split(':')[0])].opened++;
  for (const key of contacted) result[Number(key.split(':')[0])].contacted++;
  return result;
}
const historyText = h => !h ? '' : h.received ? 'за 30 дней: получил ' + h.received + ' · открыл ' + h.opened + ' · связался ' + h.contacted : 'за 30 дней заявок не получал';

function outcome(p) {
  if (p.status == null) return 'outside';
  if (p.call || p.whatsapp) return 'contacted';
  if (p.view) return 'opened';
  if (p.status === 'accepted') return 'not_opened';
  if (p.status === 'pending') return 'pending';
  if (p.status === 'failed') return 'not_delivered';
  return 'skipped';
}

const time = value => (value ? new Date(value).getTime() : Infinity);
const parts = value => Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(value)).map(part => [part.type, part.value]));
// «14.10 14:02» — время по Тбилиси; у события в тот же день, что и доставка, только «14:05».
function when(value, sameDayAs) {
  if (!value) return '';
  const p = parts(value), clock = p.hour + ':' + p.minute;
  if (sameDayAs) { const s = parts(sameDayAs); if (s.day === p.day && s.month === p.month) return clock; }
  return p.day + '.' + p.month + ' ' + clock;
}
// «через 3 мин» от доставки до действия. Без времени доставки (старые рассылки) — пусто.
function after(from, to) {
  if (!from || !to) return '';
  const minutes = Math.max(0, Math.floor((new Date(to) - new Date(from)) / 60000));
  if (minutes < 1) return 'меньше чем через минуту';
  if (minutes < 60) return 'через ' + minutes + ' мин';
  if (minutes < 24 * 60) return 'через ' + Math.floor(minutes / 60) + ' ч' + (minutes % 60 ? ' ' + (minutes % 60) + ' мин' : '');
  return 'через ' + Math.floor(minutes / (24 * 60)) + ' дн';
}

const CHANNELS = { telegram: 'Telegram', sms: 'SMS' };
const REASONS = { eligibility_changed: 'изменился допуск или баланс', need_closed: 'потребность закрыта', service_changed: 'услуги больше не подходят', language_changed: 'изменился язык', already_received: 'уже уведомлён', prior_attempt_pending: 'есть незавершённая отправка', channel_rejected: 'канал отклонил отправку', result_unknown: 'результат неизвестен', before_send_error: 'ошибка до отправки' };
const DENIED = { unavailable: 'заявка или услуга уже закрыта', forbidden: 'нет доступа к этой заявке' };
const channelName = code => CHANNELS[code] || code || '';
const reasonText = code => REASONS[code] || code || '';
const deniedText = code => DENIED[code] || 'номер не выдан';
const money = tetri => (Number(tetri || 0) / 100).toFixed(2) + ' ₾';

// Отчёт по кнопке «📊 Получатели и результаты» в Telegram модератора: итог, строка на каждого
// получателя, отправки и разбивка по услугам. Простой текст, не длиннее одного сообщения.
const MARKS = { contacted: '✅', opened: '👀', not_opened: '▫️', pending: '❔', not_delivered: '⚠️', skipped: '➖', outside: '🚫' };
const LIMIT = 40;
function recipientLine(r) {
  const parts = [MARKS[r.outcome] + ' ' + (r.name || 'Исполнитель')], reached = r.status === 'accepted' || r.status === 'pending';
  if (r.outcome === 'outside') parts.push('не был в рассылке');
  else if (r.status === 'failed') parts.push('не доставлено' + (r.reason ? ' (' + reasonText(r.reason) + ')' : ''));
  else if (r.status === 'skipped') parts.push('не отправлено' + (r.reason ? ' (' + reasonText(r.reason) + ')' : ''));
  else parts.push([channelName(r.channel), when(r.sent_at)].filter(Boolean).join(' ') + (r.status === 'pending' ? ' (результат неизвестен)' : ''));
  if (r.view) parts.push('открыл ' + when(r.view, r.sent_at) + (after(r.sent_at, r.view) ? ' (' + after(r.sent_at, r.view) + ')' : ''));
  else if (reached) parts.push('не открыл');
  if (r.call) parts.push('📞 ' + when(r.call, r.sent_at));
  if (r.whatsapp) parts.push('💬 ' + when(r.whatsapp, r.sent_at));
  for (const key of ['call', 'whatsapp']) if (r.denied[key]) parts.push((key === 'call' ? '📞' : '💬') + ' нажал ' + when(r.denied[key].at, r.sent_at) + ', номер не выдан');
  if (r.balance_tetri != null) parts.push('баланс ' + money(r.balance_tetri) + (r.low ? ' ❗' : ''));
  return parts.join(' · ');
}
const MISSED = { balance: 'не хватает баланса', billing: 'тарифы не подтверждены' };
const missedText = master => master.name + ' — ' + (MISSED[master.reason] || MISSED.balance) + ', баланс ' + money(master.balance_tetri);
// newcomers и missed — из dispatch.service: кому можно дослать и кто подходит, но не получит.
function telegramText({ order, runs, report, byCategory = [], labels = {}, newcomers = null, missed = [] }) {
  const S = report.summary, lines = ['Заявка #' + order.id + ' · кто получил и что сделал'];
  if (!runs.length && !report.rows.length) return lines.concat('Рассылок ещё нет.').join('\n');
  lines.push('Получили ' + S.received + ' · открыли ссылку ' + S.opened + ' · нажали контакт ' + S.contacted + (S.contacted ? ' (📞 ' + S.call + ', 💬 ' + S.whatsapp + ')' : '') +
    ' · не открыли ' + S.notOpened + (S.failed ? ' · не доставлено ' + S.failed : '') + (S.pending ? ' · результат неизвестен ' + S.pending : ''), '');
  report.rows.slice(0, LIMIT).forEach(r => lines.push(recipientLine(r)));
  if (report.rows.length > LIMIT) lines.push('…ещё ' + (report.rows.length - LIMIT) + ' — в карточке заявки');
  if (newcomers?.total) lines.push('', '🆕 Новые подходящие: ' + newcomers.total + ' (' + newcomers.recipients.slice(0, 10).map(master => master.name).join(', ') + (newcomers.total > 10 ? '…' : '') + '). Дослать можно в карточке заявки.');
  if (missed.length) lines.push('', '💸 Подходят, но не получили:', ...missed.slice(0, 15).map(missedText), ...(missed.length > 15 ? ['…ещё ' + (missed.length - 15) + ' — в карточке заявки'] : []));
  if (runs.length) {
    lines.push('', 'Отправки:');
    runs.slice(-3).forEach(run => lines.push((run.legacy ? 'Архивная рассылка' : labels[run.category] || run.category) + (run.vehicle_size ? ' ' + run.vehicle_size : '') + ' #' + run.id +
      ': выбрано ' + run.selected + ', принято ' + run.accepted + (run.failed ? ', ошибки ' + run.failed : '') + (run.skipped ? ', пропущено ' + run.skipped : '') + (run.pending ? ', неизвестно ' + run.pending : '')));
    if (runs.length > 3) lines.push('…и ещё ' + (runs.length - 3) + ' раньше — в карточке заявки');
  }
  if (byCategory.length > 1) {
    lines.push('', 'По услугам:');
    byCategory.forEach(row => lines.push((labels[row.category] || row.category) + ': получили ' + row.received + ' · открыли ' + row.view + ' · 📞 ' + row.call + ' · 💬 ' + row.whatsapp));
  }
  lines.push('', '✅ нажал контакт · 👀 открыл ссылку · ▫️ не открыл · ⚠️ не доставлено · ❗ баланса не хватит на следующую заявку. Время по Тбилиси. «Получил» — канал принял сообщение, прочтение неизвестно; нажатие контакта — ещё не договорённость.');
  let text = lines.join('\n');
  if (text.length > 3800) text = text.slice(0, 3750) + '\n…полный список — в карточке заявки';
  return text;
}

module.exports = { build, history, historyText, when, after, channelName, reasonText, deniedText, money, missedText, recipientLine, telegramText };
