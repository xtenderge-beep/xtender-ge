// Google Analytics 4; из него Google Ads берёт конверсии. Своя посещаемость (siteAnalytics.service)
// остаётся: она считает и страницы заявок и кабинетов, куда Google не ставится.

// Идентификатор потока данных (Администратор → Потоки данных в Google Analytics). Не секрет: виден
// в коде страницы. GA_MEASUREMENT_ID его заменяет; пустое значение выключает Google Analytics.
const PRODUCTION_ID = 'G-RP7E07YTBH';

// На локальной копии (dev-server) Google Analytics работает, только если идентификатор задан явно.
function resolveId(env) {
  const raw = env.GA_MEASUREMENT_ID !== undefined ? env.GA_MEASUREMENT_ID : (env.NODE_ENV === 'development' ? '' : PRODUCTION_ID);
  const id = String(raw).trim();
  return /^G-[A-Z0-9]{4,20}$/.test(id) ? id : '';
}

// Только открытые страницы. В адресах заявок, кабинетов и отзывов лежат секретные ссылки, а Google
// Analytics записывает адрес страницы, поэтому там его нет совсем.
const PUBLIC_PAGE = /^(?:\/(?:ru|en))?(?:\/(?:join|guides\/request|terms|privacy))?\/?$/;

const measurementId = resolveId(process.env);

function idFor(path, id = measurementId) {
  return id && PUBLIC_PAGE.test(String(path || '')) ? id : '';
}

module.exports = { resolveId, idFor, measurementId };
