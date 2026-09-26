// A request stores the exact matching rules used when its needs were configured.
// Renaming or changing a category later must not silently broaden a live dispatch.
const matchingFields = row => (row?.fields || []).filter(field => field.input !== 'text' && field.input !== 'size' && field.match && field.match !== 'ignore');

function parse(rows, categories, submitted = {}) {
  const services = {};
  const rules = {};
  for (const category of categories) {
    const slug = category === 'transport' || category === 'flatbed' ? 'van' : category;
    const row = rows.find(item => item.slug === slug && item.is_active);
    if (!row) throw new Error('Неизвестная услуга заявки');
    const raw = submitted[category] || {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректные характеристики заявки');
    const values = {};
    rules[category] = matchingFields(row).map(field => ({key:field.key,input:field.input,match:field.match,options:field.options || []}));
    for (const field of matchingFields(row)) {
      const value = raw[field.key];
      if (value === undefined || value === null || value === '') continue;
      if (field.input === 'bool') {
        if (value !== 'on' && value !== 'true' && value !== '1') throw new Error('Некорректная характеристика: ' + field.key);
        values[field.key] = true;
      } else if (field.input === 'enum') {
        if (typeof value !== 'string' || !field.options.includes(value)) throw new Error('Некорректная характеристика: ' + field.key);
        values[field.key] = value;
      } else if (field.input === 'number') {
        const number = Number(value);
        if (typeof value !== 'string' || !value.trim() || !Number.isFinite(number) ||
            (field.min != null && number < field.min) || (field.max != null && number > field.max)) throw new Error('Некорректная характеристика: ' + field.key);
        values[field.key] = number;
      }
    }
    if (Object.keys(raw).some(key => !rules[category].some(field => field.key === key))) throw new Error('Неизвестная характеристика заявки');
    services[category] = values;
  }
  return {services, rules};
}

function matches(attributes = {}, values = {}, rules = []) {
  for (const [key, requirement] of Object.entries(values)) {
    const rule = rules.find(field => field.key === key);
    if (!rule || !['exact','gte','flag'].includes(rule.match)) return false;
    const capability = attributes[key];
    if (rule.match === 'flag') { if (requirement === true && capability !== true) return false; }
    else if (capability === undefined || capability === null || capability === '') return false;
    else if (rule.match === 'exact' && capability !== requirement) return false;
    else if (rule.match === 'gte' && rule.input === 'number' && !(Number(capability) >= Number(requirement))) return false;
    else if (rule.match === 'gte' && rule.input === 'enum' &&
      (rule.options.indexOf(capability) < rule.options.indexOf(requirement) || !rule.options.includes(capability))) return false;
  }
  return true;
}

module.exports = {matchingFields, parse, matches};
