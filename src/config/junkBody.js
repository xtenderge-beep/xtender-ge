// Exact body dimensions are optional for old profiles. New profiles derive the
// existing volume tier so catalog and dispatch keep using one matching key.
const TIERS = [2, 4, 8, 15];
const VOLUME_FIELD = {
  key: 'volume_m3', input: 'enum', options: TIERS.map(String), unit: 'м³', match: 'gte', filter: true, required: true,
  labels: { ru: 'Объём кузова', ka: 'ძარის მოცულობა', en: 'Cargo volume' },
  optionLabels: Object.fromEntries(TIERS.map(n => [String(n), { ru: `от ${n} м³`, ka: `${n} მ³-დან`, en: `from ${n} m³` }])),
};
// Any vehicle may haul waste: the provider decides how to load and unload it. A tipping body
// matters only when the load has to be poured out (sand, gravel, soil) or the client asks for
// a dump truck by name, so it is an optional mark, not a required vehicle kind.
const DUMP_FIELD = { key: 'dump_body', input: 'bool', match: 'flag', filter: true, labels: { ru: 'Самосвал', ka: 'თვითმცლელი', en: 'Dump truck' } };
// Wording for the moderator's "what does the client need" step (Russian-only screens).
// Kept out of the stored field: the category editor rewrites fields on save.
const DUMP_NEED = {
  label: 'Нужен самосвал',
  hint: 'Ставьте, только если в заявке прямо просят самосвал или груз надо высыпать (песок, щебень, грунт). Без отметки заявку получат все, кто вывозит мусор.',
};
const EXTRA_FIELDS = [
  { key: 'body_length_cm', input: 'number', unit: 'см', min: 1, max: 2000, match: 'ignore', labels: { ru: 'Длина кузова', ka: 'ძარის სიგრძე', en: 'Body length' } },
  { key: 'body_width_cm', input: 'number', unit: 'см', min: 1, max: 2000, match: 'ignore', labels: { ru: 'Ширина кузова', ka: 'ძარის სიგანე', en: 'Body width' } },
  { key: 'side_height_cm', input: 'number', unit: 'см', min: 1, max: 2000, match: 'ignore', labels: { ru: 'Высота борта', ka: 'ბორტის სიმაღლე', en: 'Side height' } },
  { key: 'payload_t', input: 'number', unit: 'т', min: 0.1, max: 100, match: 'gte', filter: true, labels: { ru: 'Грузоподъёмность', ka: 'ტვირთამწეობა', en: 'Payload capacity' } },
  DUMP_FIELD,
];
const BUILT_IN_KEYS = [VOLUME_FIELD.key, ...EXTRA_FIELDS.map(field => field.key)];
// The required three-way "vehicle kind" list lived for a few hours on 2026-10-01 and was replaced
// by the dump mark. A category saved in the editor meanwhile may still carry it.
const RETIRED_KEYS = ['vehicle_kind'];
function withBuiltInFields(row) {
  if (!row || row.slug !== 'junk') return row;
  const fields = (row.fields || []).filter(field => !RETIRED_KEYS.includes(field.key));
  if (!fields.some(field => field.key === 'volume_m3')) fields.unshift(VOLUME_FIELD);
  if (fields.some(field => field.key === 'volume_m3' && field.optionLabels?.['2']?.ru === 'до 2 м³')) {
    const index = fields.findIndex(field => field.key === 'volume_m3');
    const volume = fields[index];
    fields[index] = { ...volume, optionLabels: { ...volume.optionLabels,
      '2': { ...volume.optionLabels?.['2'], ru: 'от 2 м³', en: 'from 2 m³', ka: '2 მ³-დან' },
      '4': { ...volume.optionLabels?.['4'], ru: 'от 4 м³', en: 'from 4 m³', ka: '4 მ³-დან' },
      '8': { ...volume.optionLabels?.['8'], ru: 'от 8 м³', en: 'from 8 m³', ka: '8 მ³-დან' },
    } };
  }
  for (const field of EXTRA_FIELDS) if (!fields.some(current => current.key === field.key)) fields.push(field);
  return { ...row, fields: fields.map(field => field.key === DUMP_FIELD.key ? { ...field, need: DUMP_NEED } : field) };
}
function derive(lengthCm, widthCm, sideHeightCm) {
  const dimensions = [lengthCm, widthCm, sideHeightCm].map(Number);
  if (!dimensions.every(n => Number.isFinite(n) && n > 0 && n <= 2000)) return null;
  const exactCubicMetres = dimensions.reduce((a, b) => a * b, 1) / 1e6;
  const cubicMetres = Math.round(exactCubicMetres * 100) / 100;
  // A tier is a conservative usable-capacity floor, never a rounded-up promise.
  const tier = [...TIERS].reverse().find(n => exactCubicMetres >= n);
  if (!tier) return null;
  return { cubicMetres, tier: String(tier), lengthCm: dimensions[0], widthCm: dimensions[1], sideHeightCm: dimensions[2] };
}
module.exports = { derive, withBuiltInFields, BUILT_IN_KEYS };
