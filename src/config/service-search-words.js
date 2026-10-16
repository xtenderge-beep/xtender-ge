// Слова, которыми заказчик ищет услугу на главной (public/js/service-search.js).
// К ним добавляются названия всех включённых услуг из админки на трёх языках, поэтому услуга, созданная в
// админке («Сантехники»), находится по своему названию без правки этого файла. Слово может вести к
// нескольким услугам: «переезд» — это грузчики и перевозка. Латиница — как грузины пишут в переписке.
// Не добавлять слова, которые часто встречаются в чужих задачах: «лифт» нашёл бы автовышку в каждой заявке
// «4 этаж без лифта», «квартира» — переезд в «уборке квартиры».
//
// tag — хэштег группы на трёх языках: им заказчик помечает задачу и выбирает исполнителей в каталоге. Порядок
// списка — порядок хэштегов на странице. Услуга из админки без своей группы получает хэштег из названия.
const SEARCH_WORDS = [
  {
    key: 'movers',
    tag: { ka: 'მუშები', ru: 'грузчики', en: 'movers' },
    services: ['movers'],
    words: [
      'грузчик грузчики носильщик погрузка разгрузка погрузить разгрузить поднять спустить занести вынести перенести переноска',
      'მუშა მუშები მტვირთავი ჩატვირთვა გადმოტვირთვა ამოტანა ჩამოტანა',
      'mover movers loader loaders porter helpers loading unloading',
      'musha mushebi mtvirtavi',
    ],
  },
  {
    key: 'van',
    tag: { ka: 'სატვირთო', ru: 'грузоперевозки', en: 'van' },
    services: ['van'],
    words: [
      'перевозка грузоперевозка газель фургон грузовик грузовое такси доставка довезти перевезти отвезти привезти бортовой',
      'გადაზიდვა ტვირთის ტვირთი სატვირთო მანქანა ფურგონი მიტანა',
      'van transport cargo delivery haul',
      'gadazidva tvirtis satvirto manqana furgoni',
    ],
  },
  {
    key: 'moving',
    tag: { ka: 'გადაბარგება', ru: 'переезд', en: 'moving' },
    services: ['movers', 'van'],
    words: [
      'переезд переехать мебель диван шкаф холодильник пианино',
      'გადაბარგება გადასახლება ავეჯი ავეჯის დივანი კარადა მაცივარი',
      'moving move relocation furniture sofa couch wardrobe fridge piano',
      'gadabargeba gadasaxleba aveji avejis',
    ],
  },
  {
    key: 'junk',
    tag: { ka: 'ნაგვის გატანა', ru: 'вывоз мусора', en: 'junk removal' },
    services: ['junk'],
    words: [
      'мусор вывоз вывезти хлам строительный самосвал утилизация',
      'ნაგავი ნარჩენები ნარჩენების გატანა სამშენებლო თვითმცლელი',
      'junk waste rubbish trash garbage debris removal',
      'nagavi narchenebi gatana samsheneblo',
    ],
  },
  {
    key: 'tow',
    tag: { ka: 'ევაკუატორი', ru: 'эвакуатор', en: 'tow truck' },
    services: ['tow'],
    words: [
      'эвакуатор эвакуация буксир буксировка',
      'ევაკუატორი ევაკუაცია ბუქსირი',
      'tow towing breakdown recovery',
      'evakuatori evakuator',
    ],
  },
  {
    key: 'bucket_lift',
    tag: { ka: 'ავტოამწე', ru: 'автовышка', en: 'bucket lift' },
    services: ['bucket_lift'],
    words: [
      'автовышка вышка жираф подъёмник подъемник',
      'ავტოამწე ამწე ჟირაფი',
      'bucket aerial cherry picker boom',
      'avtoamwe amwe jirafi',
    ],
  },
];

// Хэштеги-особенности: их никто не назначает, исполнитель получает их сам — по своей отметке (attribute) или по
// словам своего описания, цены и отметок (words). services — у кого такой хэштег может быть (нет — у любого).
// Слова подбирать так же осторожно, как выше: хэштег на карточке — обещание заказчику. «Разобрать» убрано:
// совпадало с «разобраться» в описании («моя работа — разобраться»).
const FEATURE_TAGS = [
  {
    key: 'piano',
    tag: { ka: 'პიანინო', ru: 'пианино', en: 'piano' },
    services: ['movers', 'van'],
    words: ['пианино рояль фортепиано', 'პიანინო როიალი', 'piano', 'pianino'],
  },
  {
    key: 'assembly',
    tag: { ka: 'ავეჯის აწყობა', ru: 'сборка мебели', en: 'furniture assembly' },
    words: ['сборка разборка собираю разбираю', 'აწყობა აწყობს', 'assembly assemble disassembly', 'awyoba'],
  },
  {
    key: 'demolition',
    tag: { ka: 'დემონტაჟი', ru: 'демонтаж', en: 'demolition' },
    words: ['демонтаж демонтировать снос', 'დემონტაჟი', 'demolition dismantling', 'demontaji'],
  },
  {
    key: 'tail_lift',
    tag: { ka: 'ჰიდრობორტი', ru: 'гидроборт', en: 'tail lift' },
    services: ['van'],
    attribute: (a) => a.tail_lift === true,
    words: ['гидроборт', 'ჰიდრობორტი', 'tailgate', 'hidroborti'],
  },
  {
    key: 'dump_truck',
    tag: { ka: 'თვითმცლელი', ru: 'самосвал', en: 'dump truck' },
    attribute: (a) => a.dump_body === true,
    words: ['самосвал', 'თვითმცლელი', 'tipper', 'tvitmcleli'],
  },
  {
    key: 'night',
    tag: { ka: '24/7', ru: 'круглосуточно', en: '24/7' },
    words: ['круглосуточно круглосуточный ночью', 'ღამით დღეღამური', 'overnight', 'gamit'],
  },
];

// categories — строки service_categories; masters — исполнители каталога этого города (listMasters с badges и
// van_vehicles). Возвращает слова для поиска, подписи услуг и хэштеги на языке страницы:
// - у каждого исполнителя: все его хэштеги (keys, для отбора) и до трёх на карточку (display) — сначала основная
//   услуга, потом особенности, потом другие услуги;
// - tags — хэштеги, у которых есть исполнители, с их числом; rowTags — десять самых частых для ряда каталога;
// - без masters (тесты, словарь) — только хэштеги услуг, без отбора.
function forPage(categories, locale, masters) {
  const search = require('../../public/js/service-search');
  const active = categories.filter((c) => c.is_active);
  const slugs = new Set(active.map((c) => c.slug));
  const entries = SEARCH_WORDS
    .map((entry) => ({ services: entry.services.filter((s) => slugs.has(s)), words: entry.words.join(' ') }))
    .filter((entry) => entry.services.length);
  active.forEach((c) => entries.push({ services: [c.slug], words: [c.name_ka, c.name_ru, c.name_en].filter(Boolean).join(' ') }));
  const labels = Object.fromEntries(active.map((c) => [c.slug, c['name_' + locale] || c.name_ru]));
  const own = new Set(SEARCH_WORDS.filter((entry) => entry.tag && entry.services.length === 1).map((entry) => entry.services[0]));
  const serviceTags = [
    ...SEARCH_WORDS.filter((entry) => entry.tag).map((entry) => ({
      key: entry.key, label: entry.tag[locale] || entry.tag.ru, words: entry.words.join(' ') + ' ' + Object.values(entry.tag).join(' '),
      services: entry.services.filter((s) => slugs.has(s)), kind: entry.services.length > 1 ? 'group' : 'service',
    })),
    ...active.filter((c) => !own.has(c.slug)).map((c) => ({
      key: c.slug, label: String(c['name_' + locale] || c.name_ru).toLowerCase(), words: [c.name_ka, c.name_ru, c.name_en].filter(Boolean).join(' '),
      services: [c.slug], kind: 'service',
    })),
  ].filter((tag) => tag.services.length);
  // Подпись хэштега-особенности ищется только в поиске: «tail lift» в описании нашло бы «лифт».
  const featureTags = FEATURE_TAGS.map((f) => ({
    key: f.key, label: f.tag[locale] || f.tag.ru, words: f.words.join(' ') + ' ' + Object.values(f.tag).join(' '),
    services: f.services ? f.services.filter((s) => slugs.has(s)) : null, attribute: f.attribute, kind: 'feature',
    inText: search.serviceMatcher([{ services: [f.key], words: f.words.join(' ') }]),
  })).filter((tag) => !tag.services || tag.services.length);

  const byMaster = new Map();
  const counts = new Map();
  (masters || []).forEach((m) => {
    const services = [m.service_type, ...(m.services || []).map((s) => s.service_type)].filter(Boolean);
    const attrs = [m.attributes, ...(m.services || []).map((s) => s.attributes), ...(m.van_vehicles || [])].filter(Boolean);
    const text = [m.description, m.price_text, m.vehicle_type, ...(m.badges || [])].filter(Boolean).join(' ');
    const has = (tag) => tag.services.some((s) => services.includes(s));
    const mine = serviceTags.filter(has);
    const features = featureTags.filter((tag) => (!tag.services || has(tag))
      && ((tag.attribute && attrs.some(tag.attribute)) || tag.inText(text).length > 0));
    const primary = mine.find((tag) => tag.kind === 'service' && tag.services[0] === m.service_type);
    const display = [primary, ...features, ...mine.filter((tag) => tag.kind === 'service' && tag !== primary)].filter(Boolean).slice(0, 3);
    const keys = [...mine, ...features].map((tag) => tag.key);
    keys.forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
    byMaster.set(m.id, { keys, display: display.map(({ key, label }) => ({ key, label })) });
  });

  const all = [...serviceTags, ...featureTags].map(({ key, label, words, services, kind }) => ({ key, label, words, services: services || [], kind, count: counts.get(key) || 0 }));
  const tags = masters ? all.filter((tag) => tag.count > 0) : all.filter((tag) => tag.kind !== 'feature');
  const rowTags = tags.slice().sort((a, b) => b.count - a.count).slice(0, 10);
  return { entries, labels, tags, rowTags, byMaster };
}

module.exports = { SEARCH_WORDS, FEATURE_TAGS, forPage };
