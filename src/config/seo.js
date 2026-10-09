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

// Карта сайта. Постоянные страницы есть на всех языках; страницы задач (landing_pages) — только на
// тех, на которых заполнены, и только включённые. pages — [{ slug, languages }].
const STATIC_PAGES = ['/', '/join', '/terms', '/privacy', '/guides/request'];

function sitemapXml(pages = []) {
  const entries = [
    ...STATIC_PAGES.map(suffix => ({ suffix, languages: PUBLIC_LOCALES })),
    ...pages.map(page => ({ suffix: '/s/' + page.slug, languages: PUBLIC_LOCALES.filter(lang => page.languages.includes(lang)) })),
  ];
  const urls = [];
  for (const { suffix, languages } of entries) {
    if (!languages.length) continue;
    const links = buildSeo(DEFAULT_LOCALE, suffix).alternates;
    const fallback = links[languages.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : languages[0]];
    const alternates = languages.map(lang => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${links[lang]}"/>`).join('\n')
      + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${fallback}"/>`;
    for (const lang of languages) urls.push(`  <url>\n    <loc>${links[lang]}</loc>\n${alternates}\n  </url>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + urls.join('\n') + '\n</urlset>\n';
}

module.exports = { buildSeo, localizedPath, sitemapXml, PUBLIC_LOCALES, DEFAULT_LOCALE };
