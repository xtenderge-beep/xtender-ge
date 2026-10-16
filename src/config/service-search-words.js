// Слова, которыми заказчик ищет услугу на тестовой главной /demo (public/js/service-search.js).
// К ним добавляются названия всех включённых услуг из админки на трёх языках, поэтому услуга, созданная в
// админке («Сантехники»), находится по своему названию без правки этого файла. Слово может вести к
// нескольким услугам: «переезд» — это грузчики и перевозка. Латиница — как грузины пишут в переписке.
// Не добавлять слова, которые часто встречаются в чужих задачах: «лифт» нашёл бы автовышку в каждой заявке
// «4 этаж без лифта», «квартира» — переезд в «уборке квартиры».
const SEARCH_WORDS = [
  {
    services: ['movers'],
    words: [
      'грузчик грузчики носильщик погрузка разгрузка погрузить разгрузить поднять спустить занести вынести перенести переноска',
      'მუშა მუშები მტვირთავი ჩატვირთვა გადმოტვირთვა ამოტანა ჩამოტანა',
      'mover movers loader loaders porter helpers loading unloading',
      'musha mushebi mtvirtavi',
    ],
  },
  {
    services: ['van'],
    words: [
      'перевозка грузоперевозка газель фургон грузовик грузовое такси доставка довезти перевезти отвезти привезти бортовой',
      'გადაზიდვა ტვირთის ტვირთი სატვირთო მანქანა ფურგონი მიტანა',
      'van transport cargo delivery haul',
      'gadazidva tvirtis satvirto manqana furgoni',
    ],
  },
  {
    services: ['movers', 'van'],
    words: [
      'переезд переехать мебель диван шкаф холодильник пианино',
      'გადაბარგება გადასახლება ავეჯი ავეჯის დივანი კარადა მაცივარი',
      'moving move relocation furniture sofa couch wardrobe fridge piano',
      'gadabargeba gadasaxleba aveji avejis',
    ],
  },
  {
    services: ['tow'],
    words: [
      'эвакуатор эвакуация буксир буксировка',
      'ევაკუატორი ევაკუაცია ბუქსირი',
      'tow towing breakdown recovery',
      'evakuatori evakuator',
    ],
  },
  {
    services: ['bucket_lift'],
    words: [
      'автовышка вышка жираф подъёмник подъемник',
      'ავტოამწე ამწე ჟირაფი',
      'bucket aerial cherry picker boom',
      'avtoamwe amwe jirafi',
    ],
  },
  {
    services: ['junk'],
    words: [
      'мусор вывоз вывезти хлам строительный самосвал утилизация',
      'ნაგავი ნარჩენები ნარჩენების გატანა სამშენებლო თვითმცლელი',
      'junk waste rubbish trash garbage debris removal',
      'nagavi narchenebi gatana samsheneblo',
    ],
  },
];

// categories — строки service_categories. Возвращает слова для поиска и подписи услуг на языке страницы.
function forPage(categories, locale) {
  const active = categories.filter((c) => c.is_active);
  const slugs = new Set(active.map((c) => c.slug));
  const entries = SEARCH_WORDS
    .map((entry) => ({ services: entry.services.filter((s) => slugs.has(s)), words: entry.words.join(' ') }))
    .filter((entry) => entry.services.length);
  active.forEach((c) => entries.push({ services: [c.slug], words: [c.name_ka, c.name_ru, c.name_en].filter(Boolean).join(' ') }));
  const labels = Object.fromEntries(active.map((c) => [c.slug, c['name_' + locale] || c.name_ru]));
  return { entries, labels };
}

module.exports = { SEARCH_WORDS, forPage };
