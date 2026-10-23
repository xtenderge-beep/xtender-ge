// Параметры заявки — то, что спрашивают у заказчика, — отдельно от характеристик исполнителя (решение 7 и уточнение 1
// владельца, docs/api-v1/BACKEND_AUDIT.md, раздел 12). Пример: «объём мусора — 2 м³» — параметр заявки, «кузов вмещает
// 5 м³» — характеристика исполнителя; их связывает maps_to: { field: <ключ характеристики>, rule }.
//   provider_gte  — у исполнителя значение не меньше (числа или варианты списка по порядку);
//   provider_eq   — у исполнителя то же значение;
//   provider_flag — заказчику нужно (true) → у исполнителя есть отметка.
// Откуда берутся параметры категории: свои из редактора (/admin/categories, service_categories.request_fields); иначе у
// встроенной услуги — BUILT_IN ниже; иначе у услуги из админки — из характеристик с правилом подбора (как было до
// разделения). Грузинские подписи — вычитка владельцем.
const RULES = ['provider_gte', 'provider_eq', 'provider_flag'];
const INPUTS = ['number', 'enum', 'bool', 'text', 'date'];
const MATCH_TO_RULE = { gte: 'provider_gte', exact: 'provider_eq', flag: 'provider_flag' };

const floor = { key: 'floor', input: 'number', min: -3, max: 60, labels: { ru: 'Этаж', ka: 'სართული', en: 'Floor' } };
const elevator = {
  key: 'elevator', input: 'enum', options: ['none', 'passenger', 'freight'],
  labels: { ru: 'Лифт', ka: 'ლიფტი', en: 'Lift' },
  optionLabels: {
    none: { ru: 'Лифта нет', ka: 'ლიფტი არ არის', en: 'No lift' },
    passenger: { ru: 'Пассажирский', ka: 'სამგზავრო', en: 'Passenger lift' },
    freight: { ru: 'Грузовой', ka: 'სატვირთო', en: 'Freight lift' },
  },
};

const BUILT_IN = {
  movers: [
    { key: 'workers', input: 'number', unit: 'person', min: 1, max: 20, labels: { ru: 'Сколько грузчиков нужно', ka: 'რამდენი მტვირთავია საჭირო', en: 'Movers needed' }, maps_to: { field: 'crew_size', rule: 'provider_gte' } },
    floor, elevator,
  ],
  van: [
    { key: 'cargo_size', input: 'enum', options: ['S', 'M', 'L', 'XL', 'XXL'], labels: { ru: 'Какая машина нужна (класс кузова)', ka: 'რა ზომის მანქანაა საჭირო', en: 'Vehicle size needed' }, maps_to: { field: 'size', rule: 'provider_gte' } },
    { key: 'body', input: 'enum', options: ['closed', 'flatbed'], labels: { ru: 'Тип кузова', ka: 'ძარის ტიპი', en: 'Body type' },
      optionLabels: { closed: { ru: 'Закрытый', ka: 'დახურული', en: 'Enclosed' }, flatbed: { ru: 'Борт (открытый)', ka: 'ბორტიანი (ღია)', en: 'Flatbed (open)' } },
      maps_to: { field: 'body', rule: 'provider_eq' } },
    { key: 'tail_lift', input: 'bool', labels: { ru: 'Нужен гидроборт', ka: 'საჭიროა ჰიდრობორტი', en: 'Tail lift needed' }, maps_to: { field: 'tail_lift', rule: 'provider_flag' } },
    { key: 'with_helpers', input: 'bool', labels: { ru: 'Нужна машина с грузчиками', ka: 'მანქანა მტვირთავებით', en: 'Van that comes with loaders' }, maps_to: { field: 'with_helpers', rule: 'provider_flag' } },
  ],
  junk: [
    { key: 'waste_volume_m3', input: 'number', unit: 'm3', min: 0.1, max: 100, labels: { ru: 'Объём мусора, м³', ka: 'ნარჩენების მოცულობა, მ³', en: 'Waste volume, m³' }, maps_to: { field: 'volume_m3', rule: 'provider_gte' } },
    { key: 'dump_body', input: 'bool', labels: { ru: 'Нужен самосвал', ka: 'საჭიროა თვითმცლელი', en: 'Dump truck needed' }, maps_to: { field: 'dump_body', rule: 'provider_flag' } },
    floor,
  ],
  tow: [
    { key: 'tow_type', input: 'enum', options: ['platform', 'spider'], labels: { ru: 'Тип погрузки', ka: 'დატვირთვის ტიპი', en: 'Loading type' },
      optionLabels: { platform: { ru: 'Платформа (полная погрузка)', ka: 'პლატფორმა (სრული დატვირთვა)', en: 'Flatbed (full load)' }, spider: { ru: 'Паук (частичная погрузка)', ka: 'ობობა (ნაწილობრივი)', en: 'Wheel-lift (partial load)' } },
      maps_to: { field: 'tow_type', rule: 'provider_eq' } },
    { key: 'vehicle_weight_t', input: 'number', unit: 't', min: 0.3, max: 40, labels: { ru: 'Масса машины, т', ka: 'მანქანის წონა, ტ', en: 'Vehicle weight, t' }, maps_to: { field: 'max_tonnage', rule: 'provider_gte' } },
  ],
  bucket_lift: [
    { key: 'work_height_m', input: 'number', unit: 'm', min: 2, max: 60, labels: { ru: 'Нужная высота, м', ka: 'საჭირო სიმაღლე, მ', en: 'Working height needed, m' }, maps_to: { field: 'work_height_m', rule: 'provider_gte' } },
  ],
};

// Поля позиции закупки (товары и смешанные заявки) — одинаковые для любой категории товаров.
const ITEM_FIELDS = ['name', 'quantity', 'unit', 'specifications', 'substitutions_allowed', 'required'];

// Параметры заявки категории (строка service_categories после withBuiltInFields).
function forCategory(category) {
  if (!category) return [];
  if (Array.isArray(category.request_fields) && category.request_fields.length) return category.request_fields;
  if (category.kind === 'goods') return [];
  if (BUILT_IN[category.slug]) return BUILT_IN[category.slug];
  // derived — подписи здесь от лица исполнителя; схема API подбирает слова заказчика (apiCatalog.fieldTitle).
  return (category.fields || []).filter((f) => MATCH_TO_RULE[f.match]).map((f) => ({
    key: f.key, input: f.input === 'size' ? 'enum' : f.input, labels: f.labels || {}, unit: f.unit, min: f.min, max: f.max,
    options: f.options, optionLabels: f.optionLabels, need: f.need, derived: true, maps_to: { field: f.key, rule: MATCH_TO_RULE[f.match] },
  }));
}

function requiredKeys(category) {
  return forCategory(category).filter((f) => f.required === true).map((f) => f.key);
}

// Проверка значений параметров одной категории. Возвращает { values, errors: [{ path, code }] }. Отсутствие значения —
// «неизвестно», а не false/0: не названное заказчиком не подставляем.
function validateValues(category, raw, path) {
  const fields = forCategory(category);
  const values = {};
  const errors = [];
  if (raw === undefined || raw === null) return { values, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { values, errors: [{ path, code: 'INVALID_VALUE' }] };
  for (const [key, value] of Object.entries(raw)) {
    const field = fields.find((f) => f.key === key);
    const at = `${path}.${key}`;
    if (!field) { errors.push({ path: at, code: 'UNKNOWN_PARAMETER' }); continue; }
    if (value === null || value === undefined || value === '') continue;
    if (field.input === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n) || (field.min != null && n < field.min) || (field.max != null && n > field.max)) errors.push({ path: at, code: 'OUT_OF_RANGE' });
      else values[key] = n;
    } else if (field.input === 'enum') {
      if (!(field.options || []).includes(String(value))) errors.push({ path: at, code: 'INVALID_OPTION' });
      else values[key] = String(value);
    } else if (field.input === 'bool') {
      if (typeof value !== 'boolean') errors.push({ path: at, code: 'INVALID_VALUE' });
      else values[key] = value;
    } else if (field.input === 'date') {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) errors.push({ path: at, code: 'INVALID_DATE' });
      else values[key] = value;
    } else {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text || text.length > 500) errors.push({ path: at, code: 'INVALID_VALUE' });
      else values[key] = text;
    }
  }
  return { values, errors };
}

function label(field, lang) {
  return field.labels?.[lang] || field.labels?.ru || field.labels?.en || field.key;
}

function valueLabel(field, value, lang) {
  if (field.input === 'bool') return value ? { ru: 'да', ka: 'კი', en: 'yes' }[lang] || 'yes' : { ru: 'нет', ka: 'არა', en: 'no' }[lang] || 'no';
  if (field.input === 'enum') return field.optionLabels?.[value]?.[lang] || field.optionLabels?.[value]?.ru || String(value);
  return String(value);
}

module.exports = { RULES, INPUTS, MATCH_TO_RULE, BUILT_IN, ITEM_FIELDS, forCategory, requiredKeys, validateValues, label, valueLabel };
