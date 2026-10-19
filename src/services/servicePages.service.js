// Автоматические страницы «услуга + город»: /s/<запрос>-<город>, например /s/mushebi-tbilisi. Их никто не
// создаёт: страница есть, пока в каталоге города есть исполнители услуги. С MIN_PROVIDERS исполнителей она
// открыта поиску, стоит в карте сайта и в ссылках; с меньшим числом открывается, но закрыта от поиска
// (пустая страница поиску вредна, а человеку по старой ссылке она ещё полезна); без исполнителей — 404.
// Страница задачи из админки с тем же адресом важнее: автоматическая тогда не показывается. Описание — docs/seo.md.
const masterService = require('./master.service');
const categoryService = require('./category.service');
const { displayName } = require('../config/providerName');
const { localizedPath } = require('../config/seo');
const PLACEHOLDERS = require('../config/service-pages-copy');
const ARTICLES = require('../config/service-pages-article');

const MIN_PROVIDERS = 3;
// Адрес — запрос грузинскими словами в латинице, как у страниц задач. Услуга из админки получает его из
// грузинского названия («სანტექნიკი» → santekniki); смена названия в админке меняет и адрес.
const BUILT_IN = { movers: 'mushebi', van: 'gadazidva', junk: 'nagvis-gatana', tow: 'evakuatori', bucket_lift: 'avtoamwe' };
// Соседние услуги встают первыми в ссылках внизу страницы.
const NEAR = { movers: ['van', 'junk'], van: ['movers'], junk: ['movers', 'van'] };

function serviceSlug(category) {
  if (BUILT_IN[category.slug]) return BUILT_IN[category.slug];
  return displayName(category.name_ka || category.name_en || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const servesKey = (master, key) => master.service_type === key || (master.services || []).some((s) => s.service_type === key);

// «в Тбилиси». По-грузински окончание -ი меняется на -ში: თბილისი → თბილისში, ბათუმი → ბათუმში.
function inCity(city, lang) {
  if (lang === 'ka') return (city.name_ka.endsWith('ი') ? city.name_ka.slice(0, -1) : city.name_ka) + 'ში';
  return lang === 'en' ? 'in ' + (city.name_en || city.name_ru) : 'в ' + city.name_ru;
}

// Страницы одного города по уже загруженному каталогу. taken — адреса страниц задач из админки.
function forCity(categories, city, masters, taken = new Set()) {
  const seen = new Set();
  return categories.filter((category) => category.is_active).flatMap((category) => {
    const head = serviceSlug(category);
    const slug = head + '-' + city.slug;
    if (!head || seen.has(slug) || taken.has(slug)) return [];
    seen.add(slug);
    const count = masters.filter((master) => servesKey(master, category.slug)).length;
    return count ? [{ slug, category, city, count, indexable: count >= MIN_PROVIDERS }] : [];
  });
}

// Услуга и город по адресу; есть ли исполнители, решает каталог при показе.
async function find(slug) {
  const [categories, cities] = await Promise.all([categoryService.list(), masterService.getActiveCities()]);
  for (const city of cities) {
    if (!slug.endsWith('-' + city.slug)) continue;
    const head = slug.slice(0, -city.slug.length - 1);
    const category = categories.find((c) => c.is_active && serviceSlug(c) === head);
    if (category) return { category, city };
  }
  return null;
}

// Открытые поиску страницы всех городов — для карты сайта.
async function published(taken = new Set()) {
  const [categories, cities] = await Promise.all([categoryService.list(), masterService.getActiveCities()]);
  const pages = [];
  for (const city of cities) {
    const masters = await masterService.listMasters({ cityId: city.id });
    pages.push(...forCity(categories, city, masters, taken).filter((page) => page.indexable));
  }
  return pages;
}

const label = (category, lang) => category['name_' + lang] || category.name_ru;
const title = (page, lang) => label(page.category, lang) + ' ' + inCity(page.city, lang);

// Всё, что нужно шаблону главной для страницы на языке lang. masters — каталог города, уже с отметками.
function view(page, lang, masters, cityPages, t) {
  const key = page.category.slug;
  const own = masters.filter((master) => servesKey(master, key));
  // Отметки этой услуги у её исполнителей (кузов, объём, гидроборт…) с числом: настоящие данные каталога.
  const features = new Map();
  own.forEach((master) => {
    const attributes = master.service_type === key ? master.attributes : (master.services || []).find((s) => s.service_type === key)?.attributes;
    new Set(categoryService.badges(page.category, attributes || {}, lang)).forEach((badge) => features.set(badge, (features.get(badge) || 0) + 1));
  });
  const near = NEAR[key] || [];
  const others = cityPages.filter((other) => other.slug !== page.slug && other.indexable)
    .sort((a, b) => Number(near.includes(b.category.slug)) - Number(near.includes(a.category.slug)) || b.count - a.count);
  const h1 = title(page, lang);
  // Свой текст услуги (статья, частые вопросы, строка для ищущих работу); без него — общий текст главной.
  const copy = ARTICLES[key]?.[lang] || {};
  return {
    slug: page.slug,
    key,
    h1,
    indexable: page.indexable,
    providers: own,
    seoTitle: h1 + ' | xtender.ge',
    seoDescription: t('seo_auto_description').replace('{h1}', h1).replace('{n}', own.length),
    placeholder: PLACEHOLDERS[key]?.[lang] || t('simple_placeholder'),
    features: [...features].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    others: others.map((other) => ({ href: localizedPath(lang, '/s/' + other.slug), title: title(other, lang) })),
    article: copy.article || [],
    faq: copy.faq || [],
    join: copy.join || null,
  };
}

module.exports = { MIN_PROVIDERS, BUILT_IN, serviceSlug, inCity, forCity, find, published, title, view };
