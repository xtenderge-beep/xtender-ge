const options = { ka: 'ქართული', ru: 'Русский', en: 'English', hy: 'Հայերեն', az: 'Azərbaycan dili', tr: 'Türkçe', uk: 'Українська' };
function parse(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  if (!values.length || values.length > 20 || values.some(v => typeof v !== 'string' || !Object.hasOwn(options, v))) return null;
  return [...new Set(values)];
}
module.exports = { options, parse };
