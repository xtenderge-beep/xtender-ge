// /admin/landings — страницы под рекламу и поиск (landingPage.service.js, docs/landing-pages.md).
const landingPages = require('../services/landingPage.service');
const masterService = require('../services/master.service');

// Число «в группе» в админке считается для Тбилиси — как на самой странице по умолчанию.
async function defaultCityId() {
  const cities = await masterService.getActiveCities();
  return (cities.find(city => city.slug === 'tbilisi') || cities[0])?.id;
}

async function index(req, res) {
  const cityId = await defaultCityId();
  const pages = [];
  for (const page of await landingPages.list()) {
    pages.push({ ...page, languages: landingPages.languages(page), group: (await landingPages.audience(page.categories, cityId)).count });
  }
  res.render('admin/landings', { pages, removed: req.query.removed === '1', minGroup: landingPages.MIN_GROUP });
}

// value — то, что показывает форма: сохранённая страница или только что отправленные поля.
async function formLocals(page, value, error) {
  return {
    page, value, error,
    groups: await landingPages.groupOptions(),
    group: (await landingPages.audience(value.categories, await defaultCityId())).count,
    languages: page ? landingPages.languages(page) : [],
    limits: landingPages.TEXT_LIMITS, minGroup: landingPages.MIN_GROUP,
  };
}

async function form(req, res) {
  const page = req.params.id ? await landingPages.get(req.params.id) : null;
  if (req.params.id && !page) return res.status(404).send('Страница не найдена');
  const value = page || { slug: '', admin_name: '', categories: [], content: {}, is_active: true, sort_order: 100 };
  res.render('admin/landing-edit', { ...(await formLocals(page, value, null)), saved: req.query.saved === '1' });
}

async function save(req, res) {
  const page = req.params.id ? await landingPages.get(req.params.id) : null;
  if (req.params.id && !page) return res.status(404).send('Страница не найдена');
  const content = req.body.content && typeof req.body.content === 'object' ? req.body.content : {};
  const input = { ...req.body, content, categories: [].concat(req.body.categories || []), is_active: req.body.is_active === 'on' };
  try {
    const saved = await landingPages.save(page?.id || null, input);
    res.redirect('/admin/landings/' + saved.id + '?saved=1');
  } catch (error) {
    if (!error.status) throw error;
    // Ошибка в одном поле не должна стирать остальной набранный текст.
    res.status(error.status).render('admin/landing-edit', { ...(await formLocals(page, input, error.message)), saved: false });
  }
}

async function remove(req, res) {
  await landingPages.remove(req.params.id);
  res.redirect('/admin/landings?removed=1');
}

module.exports = { index, form, save, remove };
