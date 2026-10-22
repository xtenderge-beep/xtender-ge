// Справочник единиц измерения для API v1 (GET /api/v1/units). Код единицы стабилен и не зависит от языка;
// подписи — ka/ru/en. LEGACY — единицы, которыми уже подписаны характеристики услуг в /admin/categories
// (там они записаны по-русски: «м³», «см», «чел.»), чтобы схема категории отдавала код, а не русское слово.
// Грузинские подписи — вычитка владельцем.
const UNITS = [
  { code: 'pcs', dimension: 'count', names: { ru: ['штука', 'шт'], ka: ['ცალი', 'ც'], en: ['piece', 'pcs'] } },
  { code: 'person', dimension: 'count', names: { ru: ['человек', 'чел.'], ka: ['კაცი', 'კაცი'], en: ['person', 'people'] } },
  { code: 'set', dimension: 'count', names: { ru: ['комплект', 'компл.'], ka: ['კომპლექტი', 'კომპლ.'], en: ['set', 'set'] } },
  { code: 'bag', dimension: 'count', names: { ru: ['мешок', 'меш.'], ka: ['ტომარა', 'ტომ.'], en: ['bag', 'bag'] } },
  { code: 'pack', dimension: 'count', names: { ru: ['упаковка', 'уп.'], ka: ['შეკვრა', 'შეკვ.'], en: ['pack', 'pack'] } },
  { code: 'kg', dimension: 'mass', names: { ru: ['килограмм', 'кг'], ka: ['კილოგრამი', 'კგ'], en: ['kilogram', 'kg'] } },
  { code: 't', dimension: 'mass', names: { ru: ['тонна', 'т'], ka: ['ტონა', 'ტ'], en: ['tonne', 't'] } },
  { code: 'cm', dimension: 'length', names: { ru: ['сантиметр', 'см'], ka: ['სანტიმეტრი', 'სმ'], en: ['centimetre', 'cm'] } },
  { code: 'm', dimension: 'length', names: { ru: ['метр', 'м'], ka: ['მეტრი', 'მ'], en: ['metre', 'm'] } },
  { code: 'm2', dimension: 'area', names: { ru: ['квадратный метр', 'м²'], ka: ['კვადრატული მეტრი', 'მ²'], en: ['square metre', 'm²'] } },
  { code: 'm3', dimension: 'volume', names: { ru: ['кубический метр', 'м³'], ka: ['კუბური მეტრი', 'მ³'], en: ['cubic metre', 'm³'] } },
  { code: 'l', dimension: 'volume', names: { ru: ['литр', 'л'], ka: ['ლიტრი', 'ლ'], en: ['litre', 'l'] } },
  { code: 'hour', dimension: 'time', names: { ru: ['час', 'ч'], ka: ['საათი', 'სთ'], en: ['hour', 'h'] } },
  { code: 'day', dimension: 'time', names: { ru: ['день', 'дн.'], ka: ['დღე', 'დღე'], en: ['day', 'day'] } },
  { code: 'trip', dimension: 'count', names: { ru: ['рейс', 'рейс'], ka: ['რეისი', 'რეისი'], en: ['trip', 'trip'] } },
];

const LEGACY = { 'шт': 'pcs', 'чел.': 'person', 'кг': 'kg', 'т': 't', 'см': 'cm', 'м': 'm', 'м²': 'm2', 'м³': 'm3', 'л': 'l', 'ч': 'hour' };

function codeFor(unit) {
  if (!unit) return null;
  if (UNITS.some((u) => u.code === unit)) return unit;
  return LEGACY[String(unit).trim()] || null;
}

function view(unit, lang) {
  const names = unit.names[lang] || unit.names.en;
  return { code: unit.code, dimension: unit.dimension, name: names[0], short: names[1] };
}

function list(lang) {
  return UNITS.map((unit) => view(unit, lang));
}

module.exports = { UNITS, LEGACY, codeFor, list, view };
