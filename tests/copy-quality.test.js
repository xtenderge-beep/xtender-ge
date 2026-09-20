// Copy regression guard for the public customer and provider screens.
// It does not judge style. It catches the failures that reach real people:
// a translation key printed as raw text, a string missing in one language,
// placeholders that differ between languages, and retired jargon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clientStrings } = require('../src/config/i18n');

const LANGS = ['ru', 'en', 'ka'];
const dictionaries = Object.fromEntries(LANGS.map(lang => [lang, clientStrings(lang)]));

// Public screens only. Admin, manager and CRM pages are internal and Russian-only by design.
const viewsRoot = path.join(__dirname, '../src/views');
const publicViews = ['index.ejs', 'join.ejs', 'order.ejs', 'master-status.ejs', 'my-orders.ejs', 'review.ejs', 'topup.ejs', 'terms.ejs', 'privacy.ejs']
  .map(name => path.join(viewsRoot, name))
  .concat(fs.readdirSync(path.join(viewsRoot, 'partials')).map(name => path.join(viewsRoot, 'partials', name)));

const used = new Map();
for (const file of publicViews) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) used.set(match[1], path.basename(file));
  // master-status.ejs keeps its own local T object for the login form, so T.* there is not the dictionary.
  if (path.basename(file) !== 'master-status.ejs') for (const match of text.matchAll(/\bT\.([A-Za-z0-9_]+)/g)) used.set(match[1], path.basename(file));
}
assert.ok(used.size > 150, 'the scanner should find the static keys of the public screens');

// 1. Every static key rendered on a public screen exists in every language.
const missing = [];
for (const [key, file] of used) {
  for (const lang of LANGS) if (dictionaries[lang][key] === undefined) missing.push(`${lang}:${key} (${file})`);
}
assert.deepEqual(missing, [], 'keys shown on public screens are missing and would print as raw identifiers');

// 2. Dynamic keys that the templates build at runtime.
const dynamic = [
  ...['van', 'movers', 'tow', 'bucket_lift', 'junk'].map(group => `service_desc_${group}_body`),
  ...[1, 2, 3, 4, 5].flatMap(n => [`faq_q${n}`, `faq_a${n}`]),
  ...[1, 2, 3].flatMap(n => [`home_step${n}_title`, `home_step${n}_body`]),
  ...['ready', 'pending', 'billing_pending', 'low', 'disabled'].flatMap(state => [`provider_${state}`, `provider_${state}_hint`]),
  'provider_billing_review_hint', 'order_lang_ka', 'order_lang_ru', 'order_lang_en',
  'pay_awaiting', 'pay_received', 'pay_reviewing', 'pay_credited', 'pay_rejected', 'pay_cancelled',
];
for (const key of dynamic) for (const lang of LANGS) assert.ok(dictionaries[lang][key], `${lang}:${key} must exist`);

// 3. A value must never look like an untranslated identifier.
for (const lang of LANGS) {
  for (const [key, value] of Object.entries(dictionaries[lang])) {
    if (typeof value === 'string') assert.ok(!/^[a-z]+(_[a-z0-9]+)+$/.test(value), `${lang}:${key} prints an identifier`);
  }
}

// 4. Placeholders must match across languages, otherwise one language shows "{price}" or drops the number.
for (const key of Object.keys(dictionaries.ru)) {
  const placeholders = lang => typeof dictionaries[lang][key] === 'string' ? [...dictionaries[lang][key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',') : null;
  const base = placeholders('ru');
  if (base === null || dictionaries.en[key] === undefined || dictionaries.ka[key] === undefined) continue;
  assert.equal(placeholders('en'), base, `en:${key} placeholders differ from ru`);
  assert.equal(placeholders('ka'), base, `ka:${key} placeholders differ from ru`);
}

// 5. Retired wording on the strings people read before they sign up or pay.
const shown = [...used.keys(), ...dynamic];
const retired = [
  [/(^|[^а-яё])лид/i, 'ru: "лид" is internal jargon; say "заявка" or "уведомление о заявке"'],
  [/платн\S* событи|за событие|за каждую услугу/i, 'ru: "paid event" wording; name the action that is charged'],
  [/Удалить заявку из системы|удалена из системы/i, 'ru: closing a request is not deleting it'],
  [/исполнитель уже найден/i, 'ru: a customer may close a request without finding a provider'],
  [/реагируйте быстрее/i, 'ru: the age of a request is not proof of a slow reply'],
  [/paid event|per event|\bleads?\b/i, 'en: retired jargon'],
];
for (const key of shown) {
  for (const lang of LANGS) {
    const value = dictionaries[lang][key];
    if (typeof value !== 'string') continue;
    for (const [pattern, why] of retired) assert.ok(!pattern.test(value), `${lang}:${key} -> ${why}\n  ${value}`);
  }
}

// 6. Registration copy states the real number of steps.
assert.match(dictionaries.ru.provider_signup_count, /из 3$/);
assert.match(dictionaries.en.provider_signup_count, /of 3$/);
assert.match(dictionaries.ka.provider_signup_count, /\/ 3$/);

console.log('PASS: public screen copy has no raw keys, no missing or mismatched translations and no retired wording.');
