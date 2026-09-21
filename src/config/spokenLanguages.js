const options = { ka: 'ქართული', ru: 'Русский', en: 'English', hy: 'Հայերեն', az: 'Azərbaycan dili', tr: 'Türkçe', uk: 'Українська' };
function parse(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  if (!values.length || values.length > 20 || values.some(v => typeof v !== 'string' || !Object.hasOwn(options, v))) return null;
  return [...new Set(values)];
}
// Названия для админки (модератор читает по-русски); options выше — родные названия для формы регистрации.
const ruNames = { ka: 'Грузинский', ru: 'Русский', en: 'Английский', hy: 'Армянский', az: 'Азербайджанский', tr: 'Турецкий', uk: 'Украинский' };
// «Говорят …» в кнопках и строках модератора.
const speakLabels = { ka: 'по-грузински', ru: 'по-русски', en: 'по-английски', hy: 'по-армянски', az: 'по-азербайджански', tr: 'по-турецки', uk: 'по-украински' };
// Языки, которые модератор выбирает кнопками в Telegram; в форме админки доступны все.
const dispatchChoices = ['ru', 'ka', 'en'];

// Адресат рассылки: '' (или 'all') — все, иначе код языка исполнителей. null — недопустимое значение.
function parseDispatchLanguage(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return '';
  return typeof value === 'string' && Object.hasOwn(options, value) ? value : null;
}

// Говорит ли исполнитель на языке — только по тому, что он сам отметил. Язык кабинета не в счёт:
// у ранних аккаунтов он равен значению по умолчанию и ничего не значит.
function speaks(master, code) {
  return Array.isArray(master && master.spoken_languages) && master.spoken_languages.includes(code);
}

// Сколько исполнителей из списка говорит на каждом языке; none — те, у кого языки не указаны.
function languageBreakdown(masters) {
  const byLanguage = Object.create(null);
  let none = 0;
  for (const m of masters) {
    const langs = Array.isArray(m.spoken_languages) ? m.spoken_languages : [];
    if (!langs.length) none++;
    for (const code of langs) byLanguage[code] = (byLanguage[code] || 0) + 1;
  }
  return { all: masters.length, byLanguage, none };
}

module.exports = { options, ruNames, speakLabels, dispatchChoices, parse, parseDispatchLanguage, speaks, languageBreakdown };
