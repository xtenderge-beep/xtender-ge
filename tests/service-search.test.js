// Поиск исполнителя на главной: слова на трёх языках и латиницей находят услугу, а слова из
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

// Хэштеги: группы из словаря, услуга из админки — по названию; без исполнителей хэштег не показывается.
assert.deepEqual(page.tags.map((tag) => tag.label), ['грузчики', 'грузоперевозки', 'переезд', 'вывоз мусора', 'эвакуатор', 'автовышка', 'сантехники']);
assert.deepEqual(words.forPage(categories, 'ka', [{ id: 1, service_type: 'movers' }, { id: 2, service_type: 'svc_plumbers' }]).tags.map((tag) => tag.label), ['მუშები', 'გადაბარგება', 'სანტექნიკოსი']);

// Хэштеги исполнителя: услуга первой, потом особенности из отметок и описания; не больше трёх на карточке.
const providers = [
  { id: 1, service_type: 'movers', description: 'Чиню сантехнику. Собираю/разбираю мебель' },
  { id: 2, service_type: 'van', description: 'Перевозка пианино', van_vehicles: [{ tail_lift: false }, { tail_lift: true }] },
  { id: 3, service_type: 'junk', description: 'Демонтаж и вывоз. Работаю круглосуточно', attributes: { dump_body: true } },
  { id: 4, service_type: 'movers', description: 'Подъём мебели без лифта. Моя работа — разобраться и так далее.' },
  { id: 5, service_type: 'movers', description: 'Перевозка пианино', services: [{ service_type: 'movers' }, { service_type: 'svc_plumbers' }] },
  // Английский перевод описания: «for» не должно давать #пианино (прежде совпадало с «фортепиано»).
  { id: 6, service_type: 'movers', description: 'Ready for any physical labor, looking for work' },
];
const tagged = words.forPage(categories, 'ru', providers);
const shown = (id) => tagged.byMaster.get(id).display.map((tag) => tag.label);
assert.deepEqual(shown(1), ['грузчики', 'сборка мебели']);
assert.deepEqual(shown(2), ['грузоперевозки', 'пианино', 'гидроборт'], 'tail lift on the second vehicle');
assert.deepEqual(shown(3), ['вывоз мусора', 'демонтаж', 'самосвал'], 'three at most');
assert.ok(tagged.byMaster.get(3).keys.includes('night'), 'the fourth one still filters');
assert.deepEqual(shown(4), ['грузчики'], 'no lift, no assembly from «разобраться»');
assert.deepEqual(shown(5), ['грузчики', 'пианино', 'сантехники']);
assert.deepEqual(tagged.byMaster.get(5).keys.sort(), ['movers', 'moving', 'piano', 'svc_plumbers']);
assert.deepEqual(shown(6), ['грузчики'], 'no piano from the English «for»');
// Ряд каталога — самые частые хэштеги с настоящим числом; хэштегов без исполнителей нет.
assert.deepEqual(tagged.rowTags.slice(0, 3).map((tag) => [tag.label, tag.count]), [['переезд', 5], ['грузчики', 4], ['пианино', 2]]);
assert.ok(!tagged.tags.some((tag) => tag.key === 'tow' || tag.count === 0));
assert.deepEqual(page.tags.find((tag) => tag.key === 'moving').services, ['movers', 'van']);
// Подсказка хэштегов по тексту задачи и по запросу поиска (на любом языке страницы).
const findTags = search.serviceMatcher(page.tags.map((tag) => ({ services: [tag.key], words: tag.words })));
assert.deepEqual(findTags('Нужно перевезти пианино на 3 этаж').sort(), ['moving', 'van']);
assert.deepEqual(findTags('ევაკუატორი მჭირდება'), ['tow']);
assert.deepEqual(findTags('убрать строительный мусор после ремонта'), ['junk']);

// Текст карточки: каждое слово запроса должно найтись, с окончаниями.
assert.equal(search.textMatches('пианино', 'Перевозка мебели и пианино без лифта'), true);
assert.equal(search.textMatches('мебель пианино', 'Перевозка мебели и пианино'), true);
assert.equal(search.textMatches('мебель сейф', 'Перевозка мебели и пианино'), false);
assert.equal(search.textMatches('гр', 'грузчики'), false);
console.log('PASS: service words in ka/ru/en/Latin, admin-created service by name, no matches from ordinary task words, hashtags only for services with providers and suggested from task text, provider hashtags from services, marks and description, row by real counts, card text with endings.');
