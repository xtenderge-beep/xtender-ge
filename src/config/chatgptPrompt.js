// Кнопка «Решить с ChatGPT» (ТЗ владельца 2026-10-21, docs/ai-agent-api.md, раздел 11): сайт собирает запрос и
// открывает chatgpt.com/?q=<запрос> — собственный ChatGPT человека, без API OpenAI. Части запроса: контекст страницы,
// как помогать (с правилом «ссылку я открою и подтвержу сам»), инструкция xtender.ge — agentApi.promptGuide, тот же
// источник и тот же каталог, что у /llms.txt. Личных данных в запросе нет: тема страницы, город и открытый адрес
// страницы без параметров (адрес chatgpt.com с запросом остаётся в истории браузера).
const copy = require('./ai-solve-copy');
const scenarios = require('./ai-scenarios');
const agentApi = require('./agentApi');

const CHATGPT = 'https://chatgpt.com/';
const LANGS = ['ka', 'ru', 'en'];
// Адрес длиннее — уходит короткий вариант запроса; скопированный текст всегда полный. 2026-10-21 сервер chatgpt.com
// отвечал и на адрес в 20 тыс. знаков; вставляет ли приложение ChatGPT на телефоне весь текст — проверка на /chatgpt.
const MAX_URL = 12000;
// Сценарии первого этапа (ТЗ, п. 11) — на тестовой странице /chatgpt.
const TEST_SCENARIOS = ['apartment_renovation', 'construction_waste', 'movers'];

// Тот же способ, что в ТЗ: new URL + searchParams.set (пробел — «+»), так владелец проверял на Android.
function chatgptUrl(prompt) {
  const url = new URL(CHATGPT);
  url.searchParams.set('q', prompt);
  return url.toString();
}

const langOf = (lang) => (LANGS.includes(lang) ? lang : 'ka');

// Сценарий страницы: свой — по адресу страницы (ai-scenarios.js); у главной — home; у остальных — тема из заголовка
// страницы и общая цель. id уходит в статистику как ai_scenario.
function scenarioFor(lang, { id, slug, title } = {}) {
  lang = langOf(lang);
  const key = id && scenarios[id] ? id : slug ? Object.keys(scenarios).find((name) => scenarios[name].pages.includes(slug)) : null;
  if (key) return { id: key, ...scenarios[key][lang] };
  if (slug && title) return { id: 'page:' + slug, title, topic: title, goal: copy[lang].genericGoal };
  return { id: 'home', ...scenarios.home[lang] };
}

function placeOf(lang, city) {
  const name = city ? city['name_' + lang] || city.name_en || city.name_ru : '';
  return [name, copy[lang].country].filter(Boolean).join(', ');
}

function fullText(lang, scenario, { base, catalog, place, source }) {
  const words = copy[lang].prompt;
  const rules = [...words.rules, ...(scenario.note ? [scenario.note] : [])];
  return [
    words.ask,
    '',
    words.context,
    `- ${words.topic}: ${scenario.topic}.`,
    `- ${words.place}: ${place}.`,
    `- ${words.source}: ${source}`,
    `- ${words.goal}: ${scenario.goal}.`,
    '',
    words.how,
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    words.guide,
    agentApi.promptGuide(base, catalog, lang),
  ].join('\n');
}

function shortText(lang, scenario, { base, catalog, place }) {
  return copy[lang].prompt.short.replace('{goal}', scenario.goal).replace('{place}', place)
    + '\n\n' + agentApi.promptGuideShort(base, catalog, lang);
}

// Всё для кнопки: тексты, полный и короткий запрос, адрес chatgpt.com. source — адрес страницы без параметров.
function build({ base, lang, catalog, scenario, city, source }) {
  lang = langOf(lang);
  const place = placeOf(lang, city);
  const options = { base, catalog: catalog || [], place, source: source || base };
  const full = fullText(lang, scenario, options);
  const short = shortText(lang, scenario, options);
  const fullUrl = chatgptUrl(full), shortUrl = chatgptUrl(short);
  const variant = fullUrl.length <= MAX_URL ? 'full' : 'short';
  const words = copy[lang];
  return {
    scenario: scenario.id, title: scenario.title, lang,
    full, short, fullUrl, shortUrl, variant, href: variant === 'full' ? fullUrl : shortUrl,
    button: words.button, hint: words.hint, copy: words.copy, opened: words.opened, copied: words.copied, copyFailed: words.copyFailed,
  };
}

module.exports = { CHATGPT, MAX_URL, TEST_SCENARIOS, chatgptUrl, scenarioFor, build };
