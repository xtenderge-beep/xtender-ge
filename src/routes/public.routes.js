const express = require('express');
const { normalizeLang, translate, clientStrings } = require('../config/i18n');
const { buildSeo } = require('../config/seo');
const masterService = require('../services/master.service');
const reviewService = require('../services/review.service');
const asyncHandler = require('../middleware/asyncHandler');

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

router.get('/', asyncHandler(async (req, res) => {
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

router.get('/join', (req, res) => {
  const locale = resolveLocale(req, res, '/join');
  res.render('join', { clientStrings: clientStrings(locale) });
});

router.get('/terms', (req, res) => {
  resolveLocale(req, res, '/terms');
  res.render('terms');
});

module.exports = router;
