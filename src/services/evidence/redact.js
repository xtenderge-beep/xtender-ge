// Безопасная копия записи журнала для архива. Сама запись в базе не меняется: в архив идёт копия, а каждое
// скрытое поле перечисляется (redacted_fields), чтобы было видно, что именно и почему не показано.
const { tail } = require('./subject');

// Ссылки на сайт: после первого раздела пути — токены кабинета, заявок, Stop, ключи доступа.
const SECRET_PATH = /(\/(?:order|o|master|review|stop|z|r|c|draft|lead|api|v1)\/)([^\s"'<>]+)/g;
const SECRET_PARAM = /([?&](?:k|key|token|t|master|owner|code)=)[^&\s"'<>]+/g;
// Кто совершил действие: исполнитель, держатель номера (Stop), заказчик — сами субъекты; остальное — сотрудники.
const SUBJECT_ACTORS = new Set(['provider', 'phone_holder', 'client', 'customer', 'registration']);

// Грузинский мобильный номер в тексте (5XX XX XX XX, с +995 и без, с пробелами или дефисами): чужой заменяется на
// «••• 123». Только отдельно стоящий: цифры внутри отпечатков, идентификаторов и кода ИП (304829194) не трогаются.
const PHONE_IN_TEXT = /(?<![\w+])(?:\+?995[\s-]?)?5\d{2}(?:[\s-]?\d){6}(?!\w)/g;

// Уже скрытое при записи в журнал («/order/[скрыто]?k=[скрыто]») не трогаем: запись остаётся как в базе.
const HIDDEN_ONLY = /^(?:\[скрыто\]|[?&][a-z]+=\[скрыто\])+$/;

function scrub(value, path, changed, phones) {
  if (typeof value === 'string') {
    const safe = value.replace(PHONE_IN_TEXT, (match) => (phones && phones.has(tail(match)) ? match : maskPhone(match))).replace(SECRET_PATH, (match, prefix, rest) => (HIDDEN_ONLY.test(rest) ? match : prefix + '[скрыто]'))
      .replace(SECRET_PARAM, (match, prefix) => (match.endsWith('=[скрыто]') ? match : prefix + '[скрыто]'));
    if (safe !== value) changed.push(path);
    return safe;
  }
  if (Array.isArray(value)) return value.map((item, index) => scrub(item, `${path}[${index}]`, changed, phones));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, path ? `${path}.${key}` : key, changed, phones)]));
  }
  return value;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? '••• ' + digits.slice(-3) : phone;
}

// row — строка sms_consent_logs как её отдал драйвер; subjectPhones — последние 9 цифр номеров субъекта;
// rules — правила цели (labels.PURPOSES).
function redactRow(row, { subjectPhones, rules }) {
  const changed = [];
  const copy = jsonSafe(row);
  if (typeof copy.metadata === 'string') { try { copy.metadata = JSON.parse(copy.metadata); } catch (_) { /* остаётся строкой */ } }
  const out = scrub(copy, '', changed, subjectPhones);
  if (out.phone_number && !subjectPhones.has(tail(out.phone_number))) { out.phone_number = maskPhone(out.phone_number); changed.push('phone_number'); }
  const metadata = out.metadata && typeof out.metadata === 'object' ? out.metadata : {};
  const actor = metadata.actor || null;
  const staff = row.event_type === 'TECHNICAL_ROUTING_CHANGED' || /^EVIDENCE_/.test(row.event_type) || /_BY_MANAGER$/.test(row.event_type)
    || (actor && !SUBJECT_ACTORS.has(actor));
  const holderHidden = actor === 'phone_holder' && !rules.holderDevice;
  if (staff || holderHidden) {
    for (const field of ['ip_address', 'user_agent', 'x_forwarded_for']) {
      if (out[field]) { out[field] = '[скрыто]'; changed.push(field); }
    }
  }
  if (!rules.adminNotes && typeof metadata.note === 'string' && metadata.note) { metadata.note = '[скрыто]'; changed.push('metadata.note'); }
  // Причины прошлых выгрузок — внутренние сведения; человеку по его запросу видно сам факт выгрузки.
  if (rules.hideExportReasons && /^EVIDENCE_/.test(row.event_type) && metadata.reason) { metadata.reason = '[скрыто]'; changed.push('metadata.reason'); }
  return { row: out, redacted: [...new Set(changed)] };
}

function redactText(text, phones = new Set()) {
  const changed = [];
  return { text: scrub(String(text ?? ''), 'text', changed, phones), changed: changed.length > 0 };
}

module.exports = { redactRow, redactText, maskPhone, jsonSafe };
