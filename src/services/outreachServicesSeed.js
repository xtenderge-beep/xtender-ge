// Шесть направлений, по которым у бота владельца много мастеров, а на сайте услуги не было (решение владельца
// 2026-11-12, docs/outreach-bot-drafts.md). Заводятся один раз обычным путём админки (category.service.save):
// отметка в app_settings не даёт вернуть категорию, которую администратор потом удалил или переименовал.
// Уже есть категория с тем же русским названием — её не трогаем. Страница «услуга + город» и кнопка в каталоге
// появляются, только когда в услуге есть одобренный исполнитель.
const MARKER = 'seed_outreach_services_2026_11';
const SERVICES = [
  { name_ka: 'ქვაბები და გათბობა', name_ru: 'Котлы и отопление', name_en: 'Boilers and heating', icon: '🔥' },
  { name_ka: 'გაზის მოწყობილობა', name_ru: 'Газовое оборудование', name_en: 'Gas equipment', icon: '🔧' },
  { name_ka: 'ფანჯრები და კარები', name_ru: 'Окна и двери', name_en: 'Windows and doors', icon: '🪟' },
  { name_ka: 'ელექტრიკოსები', name_ru: 'Электрика', name_en: 'Electricians', icon: '⚡' },
  { name_ka: 'სახურავის სამუშაოები', name_ru: 'Кровля', name_en: 'Roofing', icon: '🏠' },
  { name_ka: 'შეღებვა და ბათქაში', name_ru: 'Покраска и штукатурка', name_en: 'Painting and plastering', icon: '🎨' },
];

async function run() {
  const settings = require('./settings.service');
  if (await settings.getSetting(MARKER, null)) return { created: [], skipped: true };
  const categories = require('./category.service');
  const existing = new Set((await categories.list()).map(row => String(row.name_ru).trim().toLowerCase()));
  const created = [];
  for (const service of SERVICES) {
    if (existing.has(service.name_ru.toLowerCase())) continue;
    const saved = await categories.save(null, { ...service, is_active: true, sort_order: 100, fields: [] });
    created.push(saved.slug);
  }
  await settings.setSetting(MARKER, new Date().toISOString());
  if (created.length) console.log(`[services] added ${created.length} services for bot drafts: ${created.join(', ')}`);
  return { created, skipped: false };
}

module.exports = { run, SERVICES, MARKER };
