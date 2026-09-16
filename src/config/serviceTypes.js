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

// Тиры кузова van/transport — единственный источник правды (раньше S/L/XL/XXL и их
// см-подсказки были продублированы по отдельности в 6+ местах: schema.sql, эта
// функция, ALLOWED_SIZES в admin/order контроллерах, dispatch.service, SIZE_LABELS/
// SIZE_SPECS в telegram.service — добавить M пришлось бы в каждом; теперь один массив).
// Минимумы по каждому измерению — тариф «Грузовой» Яндекса (alfa-park-fleet.ru):
// кузов S от 170×100×90, M от 260×130×150, L от 380×180×180, XL от 400×190×200,
// XXL от 500×200×200 (см). По возрастанию — используется и для сравнения gte
// (см. category.service validate: match:'gte' сравнивает по индексу в options).
const VAN_SIZES = [
  { code: 'S', length: 170, width: 100, height: 90 },
  { code: 'M', length: 260, width: 130, height: 150 },
  { code: 'L', length: 380, width: 180, height: 180 },
  { code: 'XL', length: 400, width: 190, height: 200 },
  { code: 'XXL', length: 500, width: 200, height: 200 },
];
const VAN_SIZE_ORDER = VAN_SIZES.map(s => s.code);
// Пороги ниже — дефолт/фолбэк. Реальные см-значения теперь настраиваются из админки
// без деплоя (см. settings.service.getVanSizeThresholds, app_settings ключ
// van_size_thresholds) — буквы S/M/L/XL/XXL остаются фиксированными (на них завязаны
// CHECK-констрейнты в schema.sql и валидация в нескольких контроллерах), а вот что
// значит каждая буква в см — можно поменять. sizes передаётся вызывающей стороной,
// уже прочитавшей актуальные пороги; без него — эти дефолты.
function vanSizeSpec(code, sizes = VAN_SIZES) {
  const s = sizes.find(v => v.code === code) || VAN_SIZES.find(v => v.code === code);
  return s ? `${s.length}×${s.width}×${s.height} см` : '';
}

const SERVICE_TYPES = {
  van: {
    icon: '🚚',
    catalogGroup: true,
    catalogColor: 'bg-amber-100 text-amber-900 border-amber-200',
    fields: [
      { key: 'size', input: 'size', options: VAN_SIZE_ORDER, match: 'gte', filter: true },
      {
        key: 'body', input: 'enum', options: ['closed', 'flatbed'], match: 'exact', filter: true, required: true,
        optionIcons: { closed: 'fa-truck', flatbed: 'fa-truck-pickup' },
      },
      { key: 'tail_lift', input: 'bool', match: 'flag', filter: true },
      { key: 'with_helpers', input: 'bool', match: 'flag', filter: true },
    ],
  },

  movers: {
    icon: '💪',
    catalogGroup: true,
    catalogColor: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    fields: [
      { key: 'crew_size', input: 'number', unit: 'чел.', min: 1, max: 20, match: 'gte', required: true },
    ],
  },

  tow: {
    icon: '🛻',
    catalogGroup: true,
    catalogColor: 'bg-sky-100 text-sky-900 border-sky-200',
    fields: [
      { key: 'tow_type', input: 'enum', options: ['platform', 'spider'], match: 'exact', filter: true, required: true },
      { key: 'max_tonnage', input: 'enum', options: ['3.5', '8', '20'], unit: 'т', match: 'gte', filter: true, required: true },
    ],
  },

  bucket_lift: {
    icon: '🏗️',
    catalogGroup: true,
    catalogColor: 'bg-orange-100 text-orange-900 border-orange-200',
    fields: [
      { key: 'work_height_m', input: 'number', unit: 'м', min: 8, max: 60, match: 'gte', filter: true, required: true },
      { key: 'boom_type', input: 'enum', options: ['telescopic', 'articulated'], match: 'exact', filter: true },
    ],
  },
};

// Порядок в UI (форма, каталог, кнопки рассылки).
const SERVICE_TYPE_ORDER = ['van', 'movers', 'tow', 'bucket_lift'];

// Тир кузова из внутренних габаритов (см) по тем же порогам, что и таблица выше:
// проходим от самого крупного тира вниз, отдаём первый, для которого фургон проходит
// по всем трём измерениям сразу (как считает сам Яндекс — не по объёму).
function deriveVanSize(lengthCm, widthCm, heightCm, sizes = VAN_SIZES) {
  const l = Number(lengthCm) || 0;
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;
  if (!l || !w || !h) return null; // «любой размер» — как раньше при пустых габаритах
  for (let i = sizes.length - 1; i >= 0; i--) {
    const t = sizes[i];
    if (l >= t.length && w >= t.width && h >= t.height) return t.code;
  }
  return 'S'; // меньше минимума даже для S — не завышаем тир
}

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(SERVICE_TYPES, type);
}

function fieldsFor(type) {
  return (SERVICE_TYPES[type] && SERVICE_TYPES[type].fields) || [];
}

// Проверяет и нормализует сырой ввод формы под конфиг типа. Возвращает
// { attributes, errors }. attributes — только валидные значения (для master_services);
// errors — список ключей полей с проблемами (для показа на форме).
// input:'size' — особый: читает cargo_length/width/height_cm и выводит тир через deriveVanSize.
function validateAttributes(type, raw = {}, definedFields = fieldsFor(type)) {
  const attributes = {};
  const errors = [];
  for (const f of definedFields) {
    if (f.input === 'size') {
      const size = deriveVanSize(raw.cargo_length_cm, raw.cargo_width_cm, raw.cargo_height_cm);
      if (size) {
        attributes[f.key] = size;
        attributes.cargo_length_cm = Number(raw.cargo_length_cm) || null;
        attributes.cargo_width_cm = Number(raw.cargo_width_cm) || null;
        attributes.cargo_height_cm = Number(raw.cargo_height_cm) || null;
      } else if (f.required) {
        errors.push(f.key);
      }
      continue;
    }

    const val = raw[f.key];
    const missing = val === undefined || val === null || val === '';

    if (f.input === 'bool') {
      attributes[f.key] = val === true || val === 'true' || val === 'on' || val === '1';
      continue;
    }
    if (missing) {
      if (f.required) errors.push(f.key);
      continue;
    }
    if (f.input === 'text') {
      if (typeof val !== 'string' || !val.trim() || val.length > 500) { errors.push(f.key); continue; }
      attributes[f.key] = val.trim();
    } else if (f.input === 'enum') {
      if (!f.options.includes(String(val))) { errors.push(f.key); continue; }
      attributes[f.key] = String(val);
    } else if (f.input === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
        errors.push(f.key); continue;
      }
      attributes[f.key] = n;
    }
  }
  return { attributes, errors };
}

// Старые колонки masters — держим в синхроне, пока каталог/рассылка не переехали на
// master_services (Фазы 3–4). Для tow/bucket_lift эквивалента нет — пишем сам тип в
// category (старый каталог его просто игнорирует, старая рассылка не имеет кнопки).
function legacyColumnsFor(type, attributes = {}) {
  if (type === 'movers') return { category: 'movers', vehicle_size: null, is_flatbed: false };
  if (type === 'van') {
    return {
      category: 'transport',
      vehicle_size: attributes.size || null,
      is_flatbed: attributes.body === 'flatbed',
    };
  }
  return { category: type, vehicle_size: null, is_flatbed: false };
}

// Разворачивает конфиг в структуру для рендера формы: подписи из i18n, варианты enum
// с подписями. t — функция из require('./i18n').translate(lang).
function configForView(t) {
  return SERVICE_TYPE_ORDER.map((type) => ({
    type,
    label: t(`svc_${type}`),
    icon: SERVICE_TYPES[type].icon,
    fields: fieldsFor(type).map((f) => ({
      key: f.key,
      input: f.input,
      unit: f.unit || null,
      min: f.min != null ? f.min : null,
      max: f.max != null ? f.max : null,
      required: Boolean(f.required),
      label: t(`svc_${type}_${f.key}`),
      options: f.input === 'enum'
        ? (f.options || []).map((v) => {
            const key = `svc_${type}_${f.key}_${v}`;
            const hit = t(key);
            return {
              value: v,
              label: hit !== key ? hit : (f.unit ? `${v} ${f.unit}` : v),
              icon: (f.optionIcons && f.optionIcons[v]) || null,
            };
          })
        : (f.options || []).map((v) => ({ value: v, label: v, icon: null })),
    })),
  }));
}

// Группы каталога на главной — из типов с catalogGroup.
function catalogGroupsForView(t) {
  return SERVICE_TYPE_ORDER
    .filter((type) => SERVICE_TYPES[type].catalogGroup)
    .map((type) => ({
      key: type,
      label: t(`svc_${type}`),
      icon: SERVICE_TYPES[type].icon,
      color: SERVICE_TYPES[type].catalogColor || 'bg-stone-100 text-stone-900 border-stone-300',
      anchor: `group-${type}`,
    }));
}

// Короткие бейджи характеристик для карточки мастера в каталоге.
function attributeBadges(type, attrs, t) {
  const a = attrs || {};
  const out = [];
  for (const f of fieldsFor(type)) {
    const v = a[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.input === 'bool') {
      if (v === true || v === 'true') out.push(t(`svc_${type}_${f.key}`));
      continue;
    }
    if (f.input === 'size') { out.push(String(v)); continue; }
    if (f.input === 'enum') {
      const key = `svc_${type}_${f.key}_${v}`;
      const hit = t(key);
      out.push(hit !== key ? hit : (f.unit ? `${v} ${f.unit}` : String(v)));
      continue;
    }
    if (f.input === 'number') { out.push(f.unit ? `${v} ${f.unit}` : String(v)); }
  }
  return out;
}

module.exports = {
  SERVICE_TYPES,
  SERVICE_TYPE_ORDER,
  VAN_SIZES,
  VAN_SIZE_ORDER,
  vanSizeSpec,
  deriveVanSize,
  isKnownType,
  fieldsFor,
  validateAttributes,
  legacyColumnsFor,
  configForView,
  catalogGroupsForView,
  attributeBadges,
};
