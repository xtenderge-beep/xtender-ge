const pool = require('../config/db');
const settings = require('./settings.service');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const GROUPS = { transport: 'Перевозки', flatbed: 'Открытый кузов', movers: 'Грузчики', tow: 'Эвакуатор', bucket_lift: 'Автовышка', junk: 'Вывоз (старые профили)' };
const time = value => value ? new Date(value).getTime() : null;
const percent = (n, d) => d ? Math.round(n * 1000 / d) / 10 : null;

function windowFor(period, now = new Date()) {
  const end = now.getTime();
  // Georgian civil days, independent of the application server's timezone.
  const midnight = Math.floor((end + 4 * HOUR) / DAY) * DAY - 4 * HOUR;
  if (period && typeof period === 'object' && (period.from || period.to)) {
    const parse = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
      const ms = Date.parse(value + 'T00:00:00Z');
      return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms - 4 * HOUR : NaN;
    };
    const start = parse(period.from); const last = parse(period.to);
    if (!Number.isFinite(start) || !Number.isFinite(last) || start > last || last > midnight || last - start >= 366 * DAY) {
      const error = new Error('Выберите корректные даты: начало не позже конца, конец не позже сегодня, период до 366 дней.'); error.code = 'INVALID_RANGE'; throw error;
    }
    const selectedEnd = Math.min(last + DAY, end); const previousStart = start - (last + DAY - start);
    return { key: 'custom', start, end: selectedEnd, previousStart, previousEnd: previousStart + selectedEnd - start };
  }
  if (period && typeof period === 'object') period = period.period;
  const key = ['today', '7', '30', '90'].includes(period) ? period : 'today';
  const start = key === 'today' ? midnight : midnight - (Number(key) - 1) * DAY;
  const previousStart = key === 'today' ? start - DAY : start - Number(key) * DAY;
  return { key, start, end, previousStart, previousEnd: previousStart + end - start };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

function buildDashboard({ orders, masters, finances, queues, window, leadPrice, now }) {
  const current = orders.filter(o => time(o.created_at) >= window.start && time(o.created_at) < window.end);
  const previous = orders.filter(o => time(o.created_at) >= window.previousStart && time(o.created_at) < window.previousEnd);
  const confirmed = rows => rows.filter(o => o.status !== 'unverified');
  const summarize = rows => {
    const verified = confirmed(rows);
    const dispatched = verified.filter(o => o.first_dispatched_at);
    const viewed = dispatched.filter(o => Number(o.view_count) > 0);
    const contacted = dispatched.filter(o => Number(o.contact_count) > 0);
    const delays = contacted.map(o => (time(o.first_contact_at) - time(o.first_dispatched_at)) / 60000).filter(n => Number.isFinite(n) && n >= 0);
    return { created: rows.length, confirmed: verified.length, dispatched: dispatched.length,
      viewed: viewed.length, contacted: contacted.length, contactRate: percent(contacted.length, dispatched.length),
      average: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
      median: percentile(delays, 0.5), p90: percentile(delays, 0.9) };
  };
  const eligibleBase = m => m.is_active && !m.is_banned && m.is_subscribed && (!m.subscription_until || time(m.subscription_until) > now);
  const eligible = m => eligibleBase(m) && Number(m.balance_tetri) >= leadPrice;
  const segments = Object.entries(GROUPS).map(([key, label]) => {
    const matches = m => key === 'flatbed' ? m.category === 'transport' && m.is_flatbed : m.category === key;
    const supply = masters.filter(matches);
    const demand = confirmed(current).filter(o => (o.target_categories || []).includes(key));
    const sent = demand.filter(o => o.first_dispatched_at);
    const ready = supply.filter(eligible).length;
    const contacts = sent.filter(o => Number(o.contact_count) > 0).length;
    const lowBalance = supply.filter(m => eligibleBase(m) && Number(m.balance_tetri) < leadPrice).length;
    const unanswered = sent.filter(o => o.status !== 'closed' && !Number(o.contact_count)).length;
    let signal = 'Наблюдать';
    if (demand.length && !ready) signal = 'Нет доступных получателей';
    else if (lowBalance) signal = 'Проверить пополнения';
    else if (unanswered) signal = 'Проверить заявки без контакта';
    else if (ready && !demand.length) signal = 'Нет заявок в выбранном периоде';
    return { key, label, demand: demand.length, ready, lowBalance, unanswered, contactRate: percent(contacts, sent.length), signal };
  });
  const problems = orders.filter(o => !['closed', 'unverified'].includes(o.status) && (!o.first_dispatched_at || !Number(o.contact_count)))
    .map(o => ({ id: o.id, token: o.token, description: o.description, revision: o.status === 'needs_revision', categories: (o.target_categories || []).map(c => GROUPS[c] || c).join(', '),
      waiting: !o.first_dispatched_at, minutes: Math.max(0, Math.floor((now - time(o.first_dispatched_at || o.created_at)) / 60000)) }))
    .sort((a, b) => b.minutes - a.minutes || Number(a.id) - Number(b.id));
  const money = { current: {}, previous: {} };
  for (const row of finances) money[row.period][row.reason] = { amount: Number(row.amount) / 100, count: Number(row.count) };
  return { generatedAt: new Date(now).toISOString(), period: window.key,
    current: summarize(current), previous: summarize(previous), segments, money,
    problems: problems.slice(0, 30), problemCount: problems.length,
    waiting: problems.filter(o => o.waiting && !o.revision).length, revisions: problems.filter(o => o.revision).length, noContact: problems.filter(o => !o.waiting).length,
    unclassified: confirmed(current).filter(o => !(o.target_categories || []).length).length,
    eligible: masters.filter(eligible).length, active: masters.filter(m => m.is_active && !m.is_banned).length,
    lowBalance: masters.filter(m => eligibleBase(m) && Number(m.balance_tetri) < leadPrice).length,
    balance: masters.filter(m => !m.is_banned).reduce((sum, m) => sum + Number(m.balance_tetri), 0) / 100,
    pendingMasters: masters.filter(m => !m.is_active && !m.is_banned).length, queues };
}

async function getPeople(window, now, leadPrice) {
  const [people, managers, activity, ledger] = await Promise.all([
    pool.query(`SELECT m.id, m.name, m.phone, m.category, m.vehicle_size, m.manager_id, m.promo_code_used,
      m.is_active, m.is_banned, m.is_subscribed, m.subscription_until, m.balance_tetri, m.created_at,
      mgr.name AS manager_name, pc.manager_id AS source_manager_id, source.name AS source_manager_name
      FROM masters m LEFT JOIN managers mgr ON mgr.id = m.manager_id
      LEFT JOIN promo_codes pc ON pc.code = m.promo_code_used LEFT JOIN managers source ON source.id = pc.manager_id ORDER BY m.id DESC`),
    pool.query('SELECT id, name, is_active FROM managers ORDER BY id'),
    pool.query(`SELECT b.master_id, b.order_id, b.sent_at,
      MIN(CASE WHEN v.event_type = 'view' THEN v.viewed_at END) AS opened_at,
      MIN(CASE WHEN v.event_type IN ('call', 'whatsapp') THEN v.viewed_at END) AS contacted_at
      FROM (SELECT master_id, order_id, MIN(created_at) AS sent_at FROM balance_transactions
        WHERE reason = 'lead_charge' AND created_at >= $1 AND created_at < $2 GROUP BY master_id, order_id) b
      LEFT JOIN order_views v ON v.master_id = b.master_id AND v.order_id = b.order_id AND v.viewed_at >= b.sent_at AND v.viewed_at < $3
      GROUP BY b.master_id, b.order_id, b.sent_at`, [new Date(window.start), new Date(window.end), new Date(now)]),
    pool.query(`SELECT master_id, reason, COUNT(*)::int AS lifetime_count,
      SUM(CASE WHEN created_at >= $1 AND created_at < $2 THEN amount_tetri ELSE 0 END) AS amount,
      COUNT(CASE WHEN created_at >= $1 AND created_at < $2 THEN 1 END)::int AS period_count
      FROM balance_transactions WHERE created_at < $3 GROUP BY master_id, reason`, [new Date(window.start), new Date(window.end), new Date(now)]),
  ]);
  const responses = new Map();
  for (const row of activity.rows) {
    const key = Number(row.master_id);
    if (!responses.has(key)) responses.set(key, []);
    responses.get(key).push(row);
  }
  const transactions = new Map();
  for (const row of ledger.rows) {
    const key = Number(row.master_id);
    if (!transactions.has(key)) transactions.set(key, {});
    transactions.get(key)[row.reason] = row;
  }
  const providers = people.rows.map(m => {
    const events = responses.get(Number(m.id)) || [];
    const money = transactions.get(Number(m.id)) || {};
    const delays = events.filter(e => e.contacted_at).map(e => (time(e.contacted_at) - time(e.sent_at)) / 60000);
    const contacts = delays.length;
    return { ...m, balance: Number(m.balance_tetri) / 100,
      eligible: Boolean(m.is_active && !m.is_banned && m.is_subscribed && (!m.subscription_until || time(m.subscription_until) > now) && Number(m.balance_tetri) >= leadPrice),
      leads: events.length, opened: events.filter(e => e.opened_at).length, contacts, delays,
      average: contacts ? delays.reduce((a, b) => a + b, 0) / contacts : null,
      contactRate: percent(contacts, events.length),
      topups: Number(money.topup?.amount || 0) / 100, topupCount: Number(money.topup?.lifetime_count || 0),
      spent: -(Number(money.lead_charge?.amount || 0) + Number(money.catalog_call?.amount || 0)) / 100,
      lifetimeLeads: Number(money.lead_charge?.lifetime_count || 0),
    };
  });
  const groups = [...managers.rows, { id: null, name: 'Без назначенного менеджера', is_active: true }].map(manager => {
    const members = providers.filter(p => String(p.manager_id) === String(manager.id));
    const delays = members.flatMap(p => p.delays);
      return { ...manager, total: members.length, newCount: members.filter(p => time(p.created_at) >= window.start && time(p.created_at) < window.end).length,
      balance: members.reduce((s, p) => s + p.balance, 0), eligible: members.filter(p => p.eligible).length,
      topped: members.filter(p => p.topupCount > 0).length, repeated: members.filter(p => p.topupCount > 1).length,
      leads: members.reduce((s, p) => s + p.leads, 0), contacts: delays.length,
      topups: members.reduce((s, p) => s + p.topups, 0), spent: members.reduce((s, p) => s + p.spent, 0),
      average: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    };
  });
  return { providers, managers: groups, providerFunnel: { registered: providers.length,
    active: providers.filter(p => p.is_active && !p.is_banned).length, eligible: providers.filter(p => p.eligible).length,
    received: providers.filter(p => p.lifetimeLeads > 0).length, topped: providers.filter(p => p.topupCount > 0).length,
    repeated: providers.filter(p => p.topupCount > 1).length, contacted: providers.filter(p => p.contacts > 0).length } };
}

async function getDashboard(period) {
  const now = Date.now();
  const window = windowFor(period, new Date(now));
  const [leadPrice, orderResult, masterResult, financeResult, receiptResult, supportResult, reviewResult] = await Promise.all([
    settings.getLeadPriceTetri(),
    pool.query(`SELECT o.id, o.token, o.description, o.target_categories, o.status, o.created_at, o.first_dispatched_at,
        COUNT(CASE WHEN v.event_type = 'view' THEN 1 END)::int AS view_count,
        COUNT(CASE WHEN v.event_type IN ('call', 'whatsapp') THEN 1 END)::int AS contact_count,
        MIN(CASE WHEN v.event_type IN ('call', 'whatsapp') THEN v.viewed_at END) AS first_contact_at
      FROM orders o LEFT JOIN order_views v ON v.order_id = o.id
        AND v.viewed_at >= o.first_dispatched_at AND v.viewed_at < $2
      WHERE (o.created_at >= $1 AND o.created_at < $2) OR (o.status NOT IN ('closed', 'unverified') AND o.created_at < $2)
      GROUP BY o.id, o.token, o.description, o.target_categories, o.status, o.created_at, o.first_dispatched_at`,
      [new Date(window.previousStart), new Date(now)]),
    pool.query(`SELECT id, category, is_flatbed, is_active, is_banned, is_subscribed, subscription_until, balance_tetri FROM masters`),
    pool.query(`SELECT 'current' AS period, reason, SUM(amount_tetri) AS amount, COUNT(*)::int AS count
      FROM balance_transactions WHERE created_at >= $1 AND created_at < $2 GROUP BY reason
      UNION ALL
      SELECT 'previous' AS period, reason, SUM(amount_tetri) AS amount, COUNT(*)::int AS count
      FROM balance_transactions WHERE created_at >= $3 AND created_at < $4 GROUP BY reason`,
      [new Date(window.start), new Date(window.end), new Date(window.previousStart), new Date(window.previousEnd)]),
    pool.query("SELECT COUNT(*)::int AS count FROM topup_receipts WHERE status IN ('received','reviewing')"),
    require('./support.service').countOpenThreads(),
    pool.query('SELECT COUNT(*)::int AS count FROM master_reviews WHERE is_approved = false'),
  ]);
  const dashboard = buildDashboard({ orders: orderResult.rows, masters: masterResult.rows, finances: financeResult.rows,
    queues: { receipts: receiptResult.rows[0].count, support: supportResult, reviews: reviewResult.rows[0].count },
    window, leadPrice, now });
  Object.assign(dashboard, await getPeople(window, now, leadPrice));
  dashboard.from = new Date(window.start + 4 * HOUR).toISOString().slice(0, 10);
  dashboard.to = new Date(Math.max(window.start, window.end - 1) + 4 * HOUR).toISOString().slice(0, 10);
  dashboard.rangeQuery = window.key === 'custom' ? '&from=' + dashboard.from + '&to=' + dashboard.to : '';
  return dashboard;
}

module.exports = { getDashboard, buildDashboard, windowFor, percentile };
