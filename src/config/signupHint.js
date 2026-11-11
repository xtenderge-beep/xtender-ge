// Подсказка модератору у профиля из анкеты бота (providerDraft.service.complete): что бот предложил —
// услуги, другие направления, районы — и обещанный бесплатный период. Услуги по-прежнему назначает модератор.
function of(master) {
  let hint = master?.signup_hint;
  if (typeof hint === 'string') { try { hint = JSON.parse(hint); } catch (_) { hint = null; } }
  return hint && hint.draft_id ? hint : null;
}

// names — { slug: 'Название по-русски' } из service_categories.
function linesRu(master, names = {}) {
  const hint = of(master);
  if (!hint) return [];
  const lines = [`Анкета от бота (источник: ${master.signup_source || '—'})`];
  if (hint.services.length) lines.push(`Бот предложил услуги: ${hint.services.map(code => names[code] || code).join(', ')}`);
  if (hint.other_services.length) lines.push(`Других направлений нет на сайте: ${hint.other_services.join(', ')}`);
  if (hint.districts.length) lines.push(`Районы: ${hint.districts.join(', ')}`);
  if (master.free_until) lines.push(`Бесплатно до ${new Date(master.free_until).toLocaleDateString('ru', { timeZone: 'Asia/Tbilisi' })}`);
  return lines;
}

async function namesRu(client = require('./db')) {
  const rows = (await client.query('SELECT slug, name_ru FROM service_categories')).rows;
  return Object.fromEntries(rows.map(row => [row.slug, row.name_ru]));
}

module.exports = { of, linesRu, namesRu };
