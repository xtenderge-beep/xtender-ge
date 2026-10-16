// Поиск исполнителя на тестовой главной /demo: слова на трёх языках и латиницей находят услугу, а слова из
// обычных задач («без лифта», «уборка квартиры», «ванна») — нет.
const assert = require('node:assert/strict');
const search = require('../public/js/service-search');
const words = require('../src/config/service-search-words');

const categories = [
  ['van', 'გადაზიდვა', 'Перевозки', 'Transport'],
  ['movers', 'მუშები', 'Грузчики', 'Movers'],
  ['tow', 'ევაკუატორი', 'Эвакуатор', 'Tow truck'],
  ['bucket_lift', 'ავტოამწე (ჟირაფი)', 'Автовышка (жираф)', 'Bucket lift'],
  ['junk', 'ნარჩენების გატანა', 'Вывоз мусора', 'Waste removal'],
  ['svc_plumbers', 'სანტექნიკოსი', 'Сантехники', 'Plumbers'],
  ['hidden', 'დამალული', 'Скрытая', 'Hidden'],
].map(([slug, name_ka, name_ru, name_en]) => ({ slug, name_ka, name_ru, name_en, is_active: slug !== 'hidden' }));

const page = words.forPage(categories, 'ru');
const find = search.serviceMatcher(page.entries);
const expect = {
  'грузчики': ['movers'], 'грузчиков': ['movers'], 'mushebi': ['movers'], 'მუშები': ['movers'], 'musha': ['movers'],
  'газели': ['van'], 'gazeli': ['van'], 'переезд': ['movers', 'van'], 'ავეჯის გადაზიდვა': ['movers', 'van'],
  'evakuatori': ['tow'], 'эвакуаторы': ['tow'], 'avtoamwe': ['bucket_lift'], 'zhirafi': ['bucket_lift'],
  'мусора': ['junk'], 'nagavi': ['junk'],
  // Услуга из админки находится по своему названию на любом языке и латиницей.
  'сантехника': ['svc_plumbers'], 'santeknikosi': ['svc_plumbers'], 'plumber': ['svc_plumbers'],
  '4 этаж без лифта': [], 'уборка квартиры': [], 'ванна': [], 'скрытая': [], 'гр': [],
};
for (const [query, services] of Object.entries(expect)) {
  assert.deepEqual(find(query).sort(), services.slice().sort(), query);
}
assert.equal(page.labels.movers, 'Грузчики');
assert.equal(page.labels.hidden, undefined);

// Текст карточки: каждое слово запроса должно найтись, с окончаниями.
assert.equal(search.textMatches('пианино', 'Перевозка мебели и пианино без лифта'), true);
assert.equal(search.textMatches('мебель пианино', 'Перевозка мебели и пианино'), true);
assert.equal(search.textMatches('мебель сейф', 'Перевозка мебели и пианино'), false);
assert.equal(search.textMatches('гр', 'грузчики'), false);
console.log('PASS: service words in ka/ru/en/Latin, admin-created service by name, no matches from ordinary task words, card text with endings.');
