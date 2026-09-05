// Каталог типов услуг исполнителя — единственный источник правды о том, какие типы
// существуют, какие у каждого характеристики и как матчить их с запросом клиента.
// Из него генерируются: форма /join, фильтры каталога, кнопки рассылки в Telegram,
// форма в админке. Новый тип услуги = блок сюда + строки в i18n.js, без миграций.
//
// i18n-ключи (все нужны в ka/ru/en):
//   svc_<type>                      — название типа («Эвакуатор»)
//   svc_<type>_<fieldKey>           — подпись поля («Тип погрузки»)
//   svc_<type>_<fieldKey>_<value>   — подпись варианта enum («Паук»)
//
// Поле (field):
//   key       ключ в master_services.attributes и в атрибутах заявки
//   input     'enum' | 'number' | 'bool' | 'size' — как рисовать на форме
//             ('size' — система выводит тир из габаритов кузова, см. deriveVanSize)
//   options   для enum/size — по возрастанию значимости (match:'gte' смотрит порядок)
//   unit      суффикс для number ('м', 'т', 'чел.')
//   min,max   границы для number
//   match     'exact' | 'gte' | 'flag' | 'ignore'
//               exact  — attr === запрос (тип кузова, тип погрузки)
//               gte    — attr >= запрос; для enum сравнение по индексу в options
//               flag   — клиент просит true → нужен true у исполнителя; иначе не фильтруем
//               ignore — на форме есть, в матчинге не участвует
//   filter    true → фильтр в каталоге + кнопка в рассылке модератору
//   required  true → обязательное поле при регистрации

const SERVICE_TYPES = {
  van: {
    icon: '🚚',
    catalogGroup: true,
    fields: [
      { key: 'size', input: 'size', options: ['S', 'L', 'XL', 'XXL'], match: 'gte', filter: true },
      { key: 'body', input: 'enum', options: ['closed', 'flatbed'], match: 'exact', filter: true, required: true },
      { key: 'tail_lift', input: 'bool', match: 'flag', filter: true },
      { key: 'with_helpers', input: 'bool', match: 'flag', filter: true },
    ],
  },

  movers: {
    icon: '💪',
    catalogGroup: true,
    fields: [
      { key: 'crew_size', input: 'number', unit: 'чел.', min: 1, max: 20, match: 'gte', required: true },
    ],
  },

  tow: {
    icon: '🛻',
    catalogGroup: true,
    fields: [
      { key: 'tow_type', input: 'enum', options: ['platform', 'spider'], match: 'exact', filter: true, required: true },
      { key: 'max_tonnage', input: 'enum', options: ['3.5', '8', '20'], unit: 'т', match: 'gte', filter: true, required: true },
    ],
  },

  bucket_lift: {
    icon: '🏗️',
    catalogGroup: true,
    fields: [
      { key: 'work_height_m', input: 'number', unit: 'м', min: 8, max: 60, match: 'gte', filter: true, required: true },
      { key: 'boom_type', input: 'enum', options: ['telescopic', 'articulated'], match: 'exact', filter: true },
    ],
  },
};

// Порядок в UI (форма, каталог, кнопки рассылки).
const SERVICE_TYPE_ORDER = ['van', 'movers', 'tow', 'bucket_lift'];

// Тир кузова из внутренних габаритов (см). Исполнитель вводит размеры (или выбирает
// машину из списка — Фаза 2), система присваивает S/L/XL/XXL. Пороги — первый прикид
// по тбилисскому парку, при желании владельца правятся здесь одним местом.
//   S   — легковая, каблук (Berlingo, Doblo, Caddy)
//   L   — средний фургон (Transit, Vito)
//   XL  — макси-фургон (Sprinter Maxi, Transit L4H3), Газель-тент
//   XXL — Газель 4м+, грузовик
function deriveVanSize(lengthCm, widthCm, heightCm) {
  const l = Number(lengthCm) || 0;
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;
  if (!l || !w || !h) return null; // «любой размер» — как раньше при пустых габаритах
  const volume = (l * w * h) / 1e6; // м³
  // Ориентиры: Transit L2H2 ≈ 10 м³ → L; Sprinter Maxi ≈ 15 м³ → XL; Газель-фургон 4м ≈ 18 → XXL.
  // Длина отдельно — длинный бортовой с низкими бортами по объёму мал, но грузит крупное.
  if (volume >= 17 || l >= 450) return 'XXL';
  if (volume >= 12 || l >= 400) return 'XL';
  if (volume >= 4) return 'L';
  return 'S';
}

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(SERVICE_TYPES, type);
}

function fieldsFor(type) {
  return (SERVICE_TYPES[type] && SERVICE_TYPES[type].fields) || [];
}

module.exports = {
  SERVICE_TYPES,
  SERVICE_TYPE_ORDER,
  deriveVanSize,
  isKnownType,
  fieldsFor,
};
