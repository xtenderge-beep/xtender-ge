const { getBaseUrl } = require('./url');

const PUBLIC_LOCALES = ['ka', 'ru', 'en'];
const DEFAULT_LOCALE = 'ka';

function localizedPath(locale, suffix) {
  const clean = suffix === '/' ? '' : suffix;
  return locale === DEFAULT_LOCALE ? (clean || '/') : `/${locale}${clean}`;
}

function buildSeo(currentLocale, suffix) {
  const base = getBaseUrl();
  const alternates = {};
  PUBLIC_LOCALES.forEach((loc) => {
    alternates[loc] = base + localizedPath(loc, suffix);
  });
  return {
    canonical: alternates[currentLocale] || alternates[DEFAULT_LOCALE],
    alternates,
    xDefault: alternates[DEFAULT_LOCALE],
  };
}

module.exports = { buildSeo, localizedPath, PUBLIC_LOCALES, DEFAULT_LOCALE };
