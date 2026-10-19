// Услуги, у которых сейчас есть исполнители, по городам — для ИИ-ассистентов: /llms.txt, /openapi.json
// (rfq.controller) и MCP-сервер (mcp.controller). Из того же каталога, что страницы «услуга + город», поэтому
// ассистент не видит услуг, по которым заявку некому отправить. Запоминаем на 10 минут: эти адреса читают роботы.
const categoryService = require('./category.service');
const masterService = require('./master.service');
const servicePages = require('./servicePages.service');
const { getBaseUrl } = require('../config/url');
const { localizedPath } = require('../config/seo');

const TTL_MS = 10 * 60 * 1000;
let cache = null;

const names = (row) => ({ ka: row.name_ka, ru: row.name_ru, en: row.name_en });

async function load() {
  const [categories, cities] = await Promise.all([categoryService.list(), masterService.getActiveCities()]);
  const value = [];
  for (const city of cities) {
    const pages = servicePages.forCity(categories, city, await masterService.listMasters({ cityId: city.id }));
    if (!pages.length) continue;
    value.push({
      name: city.name_en || city.name_ru, slug: city.slug, names: names(city),
      services: pages.map((page) => ({
        code: page.category.slug, label: page.category.name_en || page.category.name_ru, names: names(page.category), count: page.count,
        url: page.indexable ? getBaseUrl() + localizedPath('en', '/s/' + page.slug) : null,
      })),
    });
  }
  return value;
}

async function get() {
  if (cache && cache.until > Date.now()) return cache.value;
  const value = await load();
  cache = { value, until: Date.now() + TTL_MS };
  return value;
}

// Сбой подсчёта каталога описание не роняет: без списка услуг оно всё равно верное.
async function getOrEmpty() {
  try { return await get(); } catch (err) { console.error('Assistant catalog unavailable:', err.message); return []; }
}

function reset() { cache = null; }

module.exports = { get, getOrEmpty, reset };
