// Ссылка-черновик от ИИ-ассистента (/draft?title=…&items=…): ассистент в чате собирает заявку и даёт человеку
// ссылку, по ней открывается обычная форма заявки с уже вписанным текстом. Дальше всё как с формы: человек
// проверяет текст, вводит номер, ставит галочки и подтверждает кодом из SMS. До этого ничего не сохраняется:
// ссылку открывают и роботы чатов, когда строят карточку предпросмотра. Формат ссылки для моделей — в /llms.txt
// (agentApi.js), устройство — docs/ai-agent-api.md.
const { detectLang } = require('../services/translation.service');
const copy = require('./draft-link-copy');

const LANGS = ['ka', 'ru', 'en'];
const LIMITS = { title: 120, items: 30, name: 200, amount: 40, loc: 80, note: 1000, cats: 10 };

// Параметр, повторённый в адресе дважды, Express отдаёт массивом: берём первый.
const first = (value) => (Array.isArray(value) ? value[0] : value);
const str = (value) => (typeof first(value) === 'string' ? first(value) : '');
// Модель иногда переносит в ссылку разметку жирного шрифта: «1 шт**» (Gemini, тест владельца 2026-10-19).
const oneLine = (value) => value.replace(/\*{2,}/g, '').replace(/\s+/g, ' ').trim();

// «Бетон М300:15:м3;Арматура d12:2:т» → [{ name: 'Бетон М300', amount: '15 м3' }, …]. Количество и единица
// необязательны; двоеточие внутри названия остаётся в названии.
function parseItems(raw) {
  return str(raw).split(';').map((part) => {
    const fields = part.split(':').map(oneLine);
    const tail = fields.length > 1 ? fields.splice(fields.length > 2 ? -2 : -1) : [];
    return { name: fields.join(': ').slice(0, LIMITS.name), amount: tail.filter(Boolean).join(' ').slice(0, LIMITS.amount) };
  }).filter((item) => item.name).slice(0, LIMITS.items);
}

// Примечание может быть в несколько строк; пустые строки и лишние пробелы убираем.
function parseNote(raw) {
  return str(raw).replace(/\r\n?/g, '\n').split('\n').map(oneLine).filter(Boolean).join('\n').slice(0, LIMITS.note);
}

// Коды услуг из /llms.txt (service_categories.slug). Есть ли такая услуга, проверяет страница.
function parseCats(raw) {
  return [...new Set(str(raw).split(',').map((code) => code.trim().toLowerCase()).filter((code) => /^[a-z0-9_]{1,32}$/.test(code)))].slice(0, LIMITS.cats);
}

// null — в ссылке нет ни названия, ни позиций, ни примечания: показывать нечего.
function parse(query) {
  const title = oneLine(str(query.title)).slice(0, LIMITS.title), items = parseItems(query.items), note = parseNote(query.note);
  if (!title && !items.length && !note) return null;
  const loc = oneLine(str(query.loc)).slice(0, LIMITS.loc);
  const wanted = str(query.lang).trim().toLowerCase();
  const lang = LANGS.includes(wanted) ? wanted : detectLang([title, ...items.map((item) => item.name), note].join(' '));
  return { title, items, note, loc, cats: parseCats(query.cats), lang };
}

// «saburtalo» или «old-tbilisi» → «Saburtalo», «Old Tbilisi»; написанное словами — как есть.
function place(loc) {
  return /^[a-z0-9_-]+$/.test(loc) ? loc.split(/[-_]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') : loc;
}

// Город каталога, если место из ссылки — это город из базы (по адресу или названию на любом языке).
function city(loc, cities) {
  const wanted = place(loc).toLowerCase();
  if (!wanted) return null;
  return cities.find((item) => [item.slug, item.name_ka, item.name_ru, item.name_en].some((name) => name && name.toLowerCase() === wanted)) || null;
}

// Текст для поля заявки: название, позиции списком, примечание и место — на языке страницы.
function text(draft, lang) {
  return [
    draft.title,
    ...draft.items.map((item) => `- ${item.name}${item.amount ? ' — ' + item.amount : ''}`),
    draft.note,
    draft.loc ? `${copy[lang].draft_place}: ${place(draft.loc)}` : '',
  ].filter(Boolean).join('\n');
}

// Готовая заявка на странице (просьба владельца 2026-10-19): по ссылке человек видит не поле с текстом, а карточку
// с кнопкой «Подтвердить заявку»; поле с тем же текстом — по кнопке «Изменить».
function review(draft) {
  return { title: draft.title, items: draft.items, note: draft.note, place: draft.loc ? place(draft.loc) : '' };
}

// Заголовок и описание карточки предпросмотра, когда ссылку пересылают в мессенджере.
function card(draft, lang) {
  const name = draft.title || (draft.items[0] && draft.items[0].name) || draft.note.split('\n')[0];
  const items = draft.items.map((item) => item.name + (item.amount ? ' — ' + item.amount : '')).join('; ');
  return {
    title: copy[lang].draft_card_title.replace('{title}', name),
    description: [items, draft.loc ? place(draft.loc) : ''].filter(Boolean).join(' · ').slice(0, 200) || copy[lang].draft_card_fallback,
  };
}

module.exports = { parse, parseItems, place, city, text, review, card, LIMITS };
