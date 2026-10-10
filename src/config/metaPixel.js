// Пиксель Meta: по нему реклама в Facebook и Instagram видит заявки. Стоит на тех же открытых
// страницах, что и Google Analytics (список — PUBLIC_PAGE в googleTag.js).
const { PUBLIC_PAGE } = require('./googleTag');

// Идентификатор набора данных (Events Manager → Источники данных). Не секрет: виден в коде страницы.
// META_PIXEL_ID его заменяет; пустое значение выключает пиксель.
const PRODUCTION_ID = '1012072607880558';

// На локальной копии (dev-server) пиксель работает, только если идентификатор задан явно.
function resolveId(env) {
  const raw = env.META_PIXEL_ID !== undefined ? env.META_PIXEL_ID : (env.NODE_ENV === 'development' ? '' : PRODUCTION_ID);
  const id = String(raw).trim();
  return /^\d{10,20}$/.test(id) ? id : '';
}

// Параметры адреса открытых страниц. Пиксель сам записывает адрес страницы целиком, убрать из него
// часть нельзя, поэтому с параметром из PRIVATE_PARAMS пиксель на просмотре не включается совсем.
// Новый параметр в public.routes.js нужно отнести к одному из списков (tests/meta-pixel.test.js).
const PRIVATE_PARAMS = ['ref', 'promo'];
const OPEN_PARAMS = ['lang', 'city'];

const pixelId = resolveId(process.env);

// Что страница передаёт скрипту пикселя (public/js/meta-pixel.js); null — пикселя на странице нет.
function tagFor(path, id = pixelId) {
  if (!id || !PUBLIC_PAGE.test(String(path || ''))) return null;
  return { id, pages: PUBLIC_PAGE.source, privateParams: PRIVATE_PARAMS.join(',') };
}

module.exports = { resolveId, tagFor, pixelId, PRIVATE_PARAMS, OPEN_PARAMS };
