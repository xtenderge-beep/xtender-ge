const pool = require('../config/db');
const supportService = require('./support.service');

// Цифры на вкладках меню админки. Цифра горит, пока на вкладке есть необработанное: заявка без
// рассылки, профиль на проверке, неподтверждённый чек, отзыв на проверке, обращение без ответа
// (решение владельца 11.10.2026: «пока не подтвердим — пусть горит»). К этому добавляется новое,
// что пришло с последнего захода на вкладку и уже обработано кем-то другим, — оно гаснет, когда
// администратор зашёл. Вход в админку один, поэтому отметка «видел до» одна на вкладку и общая
// для всех устройств — строка в app_settings.
const SECTIONS = ['orders', 'masters', 'receipts', 'reviews', 'support'];
const LIMIT = 200;
const settingKey = section => 'admin_seen_' + section + '_at';
const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;

// Для каждой вкладки: fresh — новое с отметки since (его страница помечает), waiting — ждёт
// обработки. Одно определение и для цифры в меню, и для пометок в списке.
const sections = {
  // Заявка доходит до модератора, когда заказчик подтвердил телефон; до этого она не новость.
  // Заявку, которую заказчик исправил после возврата на доработку, надо прочитать заново.
  // Ждёт обработки — то же, что фильтр «Ожидают рассылки»; «у клиента на доработке» ждёт не нас.
  orders: async since => {
    const [arrived, resubmitted, waiting] = await Promise.all([
      rows(`SELECT id, token, description FROM orders
            WHERE status <> 'unverified' AND COALESCE(confirmed_at, created_at) > $1
            ORDER BY id DESC LIMIT ${LIMIT}`, [since]),
      rows(`SELECT o.id, o.token, o.description FROM sms_consent_logs l JOIN orders o ON o.id = l.order_id
            WHERE l.event_type = 'ORDER_RESUBMITTED' AND l.timestamp_utc > $1 LIMIT ${LIMIT}`, [since]),
      rows(`SELECT id FROM orders WHERE status = 'pending_review' AND first_dispatched_at IS NULL LIMIT ${LIMIT}`),
    ]);
    const byId = new Map([...arrived, ...resubmitted].map(row => [row.id, row]));
    return { fresh: [...byId.values()].sort((a, b) => b.id - a.id), waiting };
  },
  // Ждёт обработки — то же, что плашка «На модерации»: отложенные «на уточнение» в неё не входят.
  masters: async since => {
    const [fresh, waiting] = await Promise.all([
      rows(`SELECT id, name, phone FROM masters WHERE created_at > $1 ORDER BY id DESC LIMIT ${LIMIT}`, [since]),
      rows(`SELECT id FROM masters WHERE (is_active = false OR is_active IS NULL) AND is_banned = false
            AND id NOT IN (SELECT master_id FROM admin_master_followups) LIMIT ${LIMIT}`),
    ]);
    return { fresh, waiting };
  },
  // Вкладка «Чеки» — список счетов на пополнение. Новое: счёт или чек к прежнему счёту. Ждёт
  // обработки счёт с приложенным чеком; счёт без чека может быть и не оплачен — он только новость.
  receipts: async since => {
    const [topups, receipts, waiting] = await Promise.all([
      rows(`SELECT id FROM topup_requests WHERE status <> 'cancelled' AND created_at > $1 LIMIT ${LIMIT}`, [since]),
      rows(`SELECT t.id FROM topup_receipts r JOIN topup_requests t ON t.id = r.topup_id
            WHERE t.status <> 'cancelled' AND r.created_at > $1 LIMIT ${LIMIT}`, [since]),
      rows(`SELECT id FROM topup_requests WHERE status IN ('received', 'reviewing') LIMIT ${LIMIT}`),
    ]);
    return { fresh: [...new Set([...topups, ...receipts].map(row => row.id))].map(id => ({ id })), waiting };
  },
  reviews: async since => {
    const waiting = await rows(`SELECT id, created_at FROM master_reviews WHERE is_approved = false LIMIT ${LIMIT}`);
    return { fresh: waiting.filter(review => new Date(review.created_at) > since), waiting };
  },
  // Обращение ждёт, пока на него не ответили: ответ из Telegram тоже его снимает.
  support: async since => {
    const open = (await supportService.listThreads()).filter(thread => thread.is_open)
      .map(thread => ({ id: thread.master_id, last_at: thread.last_at }));
    return { fresh: open.filter(thread => new Date(thread.last_at) > since), waiting: open };
  },
};

// Отметки всех вкладок одним запросом. Вкладка без отметки начинает отсчёт с этого момента:
// иначе при первом запуске вся прежняя база стала бы «новой».
async function seenMarks(now = new Date()) {
  const keys = SECTIONS.map(settingKey);
  const saved = new Map((await rows(
    `SELECT key, value FROM app_settings WHERE key IN (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys))
    .map(row => [row.key, new Date(row.value)]));
  const marks = {};
  for (const section of SECTIONS) {
    const at = saved.get(settingKey(section));
    if (at && !Number.isNaN(at.getTime())) { marks[section] = at; continue; }
    await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [settingKey(section), now.toISOString()]);
    marks[section] = now;
  }
  return marks;
}

// Новое и ждущее обработки пересекаются: каждая строка в цифре один раз.
const total = ({ fresh, waiting }) => new Set([...fresh, ...waiting].map(row => row.id)).size;

async function counts() {
  const marks = await seenMarks();
  const found = await Promise.all(SECTIONS.map(section => sections[section](marks[section])));
  return Object.fromEntries(SECTIONS.map((section, i) => [section, total(found[i])]));
}

// Заход на вкладку: отдаёт то, что было новым, и то, что всё ещё ждёт обработки, и сдвигает
// отметку. Время берём до выборки — пришедшее, пока шёл запрос, останется новым до следующего
// захода, а не потеряется.
async function open(section, now = new Date()) {
  if (!SECTIONS.includes(section)) throw new Error('Unknown admin section: ' + section);
  const since = (await seenMarks(now))[section];
  const found = await sections[section](since);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [settingKey(section), now.toISOString()]);
  return found;
}

module.exports = { SECTIONS, counts, open };
