const express = require('express');
const { normalizeLang, translate, clientStrings } = require('../config/i18n');
const { buildSeo } = require('../config/seo');
const { SERVICE_REQUISITES } = require('../config/legal');
const legalContent = require('../config/legal-content');
const masterService = require('../services/master.service');
const reviewService = require('../services/review.service');
const promoService = require('../services/promo.service');
const asyncHandler = require('../middleware/asyncHandler');

const LEGAL_LOCALS = {
  requisites: SERVICE_REQUISITES,
  reqLabels: legalContent.REQUISITE_LABELS,
  reqPending: legalContent.REQUISITE_PENDING,
  labels: legalContent.LABELS,
};

const router = express.Router({ mergeParams: true });
const LANG_COOKIE_OPTS = { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' };

function resolveLocale(req, res, suffix) {
  const locale = normalizeLang(req.params.locale);
  res.locals.lang = locale;
  res.locals.t = translate(locale);
  res.locals.seo = buildSeo(locale, suffix);
  res.cookie('lang', locale, LANG_COOKIE_OPTS);
  return locale;
}

// Пришли на публичную страницу БЕЗ языкового префикса, но в куке уже выбран ru/en —
// уводим на префиксную версию (напр. /join → /ru/join), чтобы весь путь был на одном
// языке. Googlebot куку не шлёт → всегда видит ka на «голых» URL, SEO не страдает.
//
// ?lang=ka — явный клик по грузинскому флагу в переключателе (единственный язык без
// префикса в URL, поэтому его ссылка неотличима от «просто зашёл на голый /» — без этой
// метки кука ru/en тут же перебивала бы обратно и на ka было невозможно переключиться).
function redirectToCookieLocale(req, res, path) {
  if (req.params.locale) return false;
  if (req.query.lang === 'ka') return false;
  const cookieLang = normalizeLang(req.cookies.lang);
  if (cookieLang === 'ka') return false;
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(302, `/${cookieLang}${path}${qs}`);
  return true;
}

router.get('/', asyncHandler(async (req, res) => {
  if (redirectToCookieLocale(req, res, '')) return;
  const locale = resolveLocale(req, res, '/');
  const masters = await masterService.listMasters();
  const reviews = await reviewService.listApprovedForMasters(masters.map((m) => m.id));
  const reviewsByMaster = new Map();
  reviews.forEach((rv) => {
    if (!reviewsByMaster.has(rv.master_id)) reviewsByMaster.set(rv.master_id, []);
    reviewsByMaster.get(rv.master_id).push(rv);
  });
  masters.forEach((m) => { m.reviews = reviewsByMaster.get(m.id) || []; });
  res.render('index', { masters, clientStrings: clientStrings(locale) });
}));

router.get('/join', asyncHandler(async (req, res) => {
  if (redirectToCookieLocale(req, res, '/join')) return;
  const locale = resolveLocale(req, res, '/join');
  const codeParam = (req.query.promo || '').trim().toUpperCase().slice(0, 40);
  let promo = null;
  if (codeParam) {
    const valid = await promoService.peek(codeParam);
    promo = valid
      ? { code: valid.code, amountGel: valid.amount_tetri / 100, valid: true }
      : { code: codeParam, valid: false };
  }
  res.render('join', { clientStrings: clientStrings(locale), promo });
}));

// Короткая реферальная ссылка: /r/КОД → форма регистрации с подставленным промокодом.
router.get('/r/:code', (req, res) => {
  res.redirect(`/join?promo=${encodeURIComponent((req.params.code || '').toUpperCase())}`);
});

router.get('/terms', (req, res) => {
  if (redirectToCookieLocale(req, res, '/terms')) return;
  resolveLocale(req, res, '/terms');
  res.render('terms', { legalDoc: legalContent.terms, ...LEGAL_LOCALS });
});

router.get('/privacy', (req, res) => {
  if (redirectToCookieLocale(req, res, '/privacy')) return;
  resolveLocale(req, res, '/privacy');
  res.render('privacy', { legalDoc: legalContent.privacy, ...LEGAL_LOCALS });
});

module.exports = router;
