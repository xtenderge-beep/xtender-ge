// «Кто вы?» на /join (2026-10-17): исполнитель отмечает один или несколько типов. Это подсказка модератору,
// какие услуги назначить; рассылку и каталог не меняет (услуги по-прежнему назначает модератор).
const KINDS = ['worker', 'vehicle', 'store'];
const LABELS_RU = { worker: 'Мастер или бригада', vehicle: 'Машина или техника', store: 'Строительный магазин' };

// Значение из формы: строка, массив строк или ничего. null — пришло что-то не из списка.
function parse(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some(item => !KINDS.includes(item))) return null;
  return KINDS.filter(kind => list.includes(kind));
}

// Колонка JSONB: настоящий Postgres отдаёт массив, pg-mem значение по умолчанию — строкой.
function of(master) {
  const raw = master?.signup_kinds;
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch (_) { return []; } })() : raw;
  return Array.isArray(list) ? KINDS.filter(kind => list.includes(kind)) : [];
}

const labelsRu = master => of(master).map(kind => LABELS_RU[kind]);

module.exports = { KINDS, LABELS_RU, parse, of, labelsRu };
