const consentService = require('../services/consent.service');
const express = require('express');
const { normalizeLang, translate, clientStrings } = require('../config/i18n');
const serviceTypes = require('../config/serviceTypes');
const { buildSeo } = require('../config/seo');
const { SERVICE_REQUISITES } = require('../config/legal');
const legalContent = require('../config/legal-content');
const legalContentService = require('../services/legalContent.service');
const masterService = require('../services/master.service');
const managerService = require('../services/manager.service');
const reviewService = require('../services/review.service');
const promoService = require('../services/promo.service');
const settingsService = require('../services/settings.service');
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
  const catalogCities = await masterService.getActiveCities();
  const catalogCity = catalogCities.find(city => city.slug === req.query.city) || catalogCities.find(city => city.slug === 'tbilisi') || catalogCities[0];
  const [masters, catalogCallPriceTetri] = await Promise.all([
    masterService.listMasters({ language: locale, cityId: catalogCity?.id }),
    settingsService.getCatalogCallPriceTetri(),
  ]);
  res.set('Cache-Control', 'private, no-store');
  const callerPhone = await require('../services/catalogSession.service').getPhone(req);
  const history = new Map((await masterService.contactHistory(callerPhone)).map(h => [h.master_id, h.opened_at]));
  const { formattedPhone } = require('../config/catalogContacts');
  masters.forEach(m => {
    m.contact_opened = history.has(m.id);
    // Full number only for a caller who already opened this provider; everyone else sees the masked start.
    m.phone_display = m.contact_opened ? formattedPhone(m.phone) : m.phone_masked;
    // Whether the card shows contact buttons or «temporarily unavailable».
    m.reachable = m.contact_opened || (m.billing_accepted === true && m.balance_tetri >= catalogCallPriceTetri);
  });
  // Reachable providers go first, so a row of cards rarely mixes a tall card with buttons and a short
  // «unavailable» one. The sort is stable: the language order from listMasters is kept inside each half.
  masters.sort((a, b) => Number(b.reachable) - Number(a.reachable));
  const reviews = await reviewService.listApprovedForMasters(masters.map((m) => m.id));
  const reviewsByMaster = new Map();
  reviews.forEach((rv) => {
    if (!reviewsByMaster.has(rv.master_id)) reviewsByMaster.set(rv.master_id, []);
    reviewsByMaster.get(rv.master_id).push(rv);
  });
  masters.forEach((m) => { m.reviews = reviewsByMaster.get(m.id) || []; });
  const t = translate(locale);
  const categoryService = require('../services/category.service');
  const categories = await categoryService.list();
  masters.forEach(m => { m.badges = [...(m.services || []).filter(s=>s.service_type !== m.service_type).map(s=>{const c=categories.find(c=>c.slug===s.service_type);return c?.['name_'+locale] || c?.name_ru || s.service_type;}), ...categoryService.badges(categories.find(c=>c.slug===m.service_type),m.attributes,locale)]; });

  // Несколько машин у исполнителя перевозок: фильтры каталога проверяют каждую машину отдельно.
  masters.forEach(m => {
    const van = m.service_type === 'van' ? m.attributes : (m.services || []).find(s => s.service_type === 'van')?.attributes;
    const vehicles = van ? require('../config/serviceTypes').vanVehicles(van) : [];
    m.van_vehicles = vehicles.length > 1 ? vehicles : null;
  });

  // Пришёл по ссылке менеджера (/z/<token>) — подставим телефон в форму заявки.
  let prefillPhone = '';
  const inviteToken = req.cookies.order_invite;
  if (inviteToken) {
    const invite = await managerService.getClientInvite(inviteToken);
    if (invite) prefillPhone = invite.phone;
  }

  res.render('index', {
    consent: await consentService.bundle('client', locale),
    masters,
    catalogCities,
    catalogCity,
    catalogCallPriceTetri,
    prefillPhone,
    clientStrings: clientStrings(locale),
    catalogGroups: await categoryService.catalogGroups(locale),
    catalogServiceConfig: await categoryService.configForView(locale),
  });
}));

// Персональная ссылка менеджера для заказчика. Ставим куку с токеном приглашения,
// отмечаем открытие, отправляем на форму заявки.
router.get('/z/:token', asyncHandler(async (req, res) => {
  const invite = await managerService.getClientInvite(req.params.token);
  if (!invite) return res.redirect('/');
  await managerService.markInviteOpened(invite.token);
  res.cookie('order_invite', invite.token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  const locale = req.cookies.lang && ['ru', 'en'].includes(req.cookies.lang) ? '/' + req.cookies.lang : '';
  res.redirect(`${locale}/#post-section`);
}));

// Ссылка /join в нужном языковом варианте: ru/en получают префикс, ka — явную метку
// ?lang=ka (без неё голый /join, если в куке остался ru/en с прошлого визита БРАУЗЕРА,
// тут же уведёт обратно — см. redirectToCookieLocale/lang-switch.ejs). Без hint — как
// раньше: решает кука посетителя, а если её нет, дефолт ka.
function joinUrl(ref, lang) {
  const qs = 'ref=' + encodeURIComponent(ref);
  if (lang === 'ru' || lang === 'en') return `/${lang}/join?${qs}`;
  if (lang === 'ka') return `/join?${qs}&lang=ka`;
  return `/join?${qs}`;
}

// Public referral alias; the manager ID prevents collisions between token prefixes.
// ?lang=ru|ka|en — менеджер знает язык получателя и явно выбирает вариант ссылки
// (см. /admin/managers/:id и /manager — три варианта вместо одной ссылки), это
// надёжнее, чем гадать по куке браузера получателя (её обычно вообще нет — первый визит).
router.get('/p/:code', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const match = /^([1-9a-z][0-9a-z]{0,6})-([a-f0-9]{8})$/.exec(req.params.code);
  const id = match ? parseInt(match[1], 36) : 0;
  if (!id || id > 2147483647 || id.toString(36) !== match[1]) return res.status(404).send('Ссылка не найдена');
  const manager = await require('../services/partner.service').getManager(id);
  if (!manager?.is_active || !manager.referral_token || manager.referral_token.slice(0, 8) !== match[2]) return res.status(404).send('Ссылка не найдена');
  const lang = ['ru', 'ka', 'en'].includes(req.query.lang) ? req.query.lang : null;
  res.redirect(joinUrl(manager.referral_token, lang));
}));

router.get('/join', asyncHandler(async (req, res) => {
  if (redirectToCookieLocale(req, res, '/join')) return;
  const locale = resolveLocale(req, res, '/join');
  const partner = require('../services/partner.service');
  const incomingRef = typeof req.query.ref === 'string' ? req.query.ref : '';
  const incomingReferrer = incomingRef ? await partner.findReferrer(incomingRef, null) : null;
  const cookieReferrer = await partner.findReferrer(req.cookies.partner_ref, null);
  if (incomingReferrer && !cookieReferrer) {
    res.cookie('partner_ref', incomingRef, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600000, path: '/' });
  }
  const codeParam = (typeof req.query.promo === 'string' ? req.query.promo : '').trim().toUpperCase().slice(0, 40);
  let promo = null;
  if (codeParam) {
    const valid = await promoService.peek(codeParam);
    promo = valid
      ? { code: valid.code, amountGel: valid.amount_tetri / 100, valid: true }
      : { code: codeParam, valid: false };
  }

  const t = translate(locale);
  const nameKey = { ka: 'name_ka', ru: 'name_ru', en: 'name_en' }[locale] || 'name_ru';
  const cities = await masterService.getActiveCities();

  const [leadPriceTetri, catalogCallPriceTetri] = await Promise.all([settingsService.getLeadPriceTetri(), settingsService.getCatalogCallPriceTetri()]);
  const welcomeBonusTetri = await settingsService.getWelcomeBonusTetri();
  // Someone who arrives by a manager's referral link or a promo link already knows why they came.
  // For them the page is the registration form and nothing else. Organic visitors keep the full page.
  const focused = Boolean(incomingReferrer || cookieReferrer || codeParam);
  // The language switcher points at clean URLs, so the link parameters are carried explicitly.
  // Otherwise a language change would drop the promo code and the focused mode.
  const carried = new URLSearchParams();
  if (incomingReferrer) carried.set('ref', incomingRef);
  if (codeParam) carried.set('promo', codeParam);
  res.render('join', {
    consent: await consentService.bundle('provider', locale),
    legalDoc: await legalContentService.getTerms(), ...LEGAL_LOCALS,
    welcomeBonusTetri, leadPriceTetri, catalogCallPriceTetri,
    focused, switchQuery: carried.toString(),
    clientStrings: clientStrings(locale),
    promo,
    cities: cities.map((c) => ({ id: c.id, name: c[nameKey] || c.name_ka })),
  });
}));

// Короткая реферальная ссылка: /r/КОД → форма регистрации с подставленным промокодом.
router.get('/r/:code', (req, res) => {
  res.redirect(`/join?promo=${encodeURIComponent((req.params.code || '').toUpperCase())}`);
});

router.get('/guides/request', (req, res) => {
  if (redirectToCookieLocale(req, res, '/guides/request')) return;
  const locale = resolveLocale(req, res, '/guides/request');
  res.render('customer-guide', {guide: require('../config/customer-guide-copy')[locale], home: locale === 'ka' ? '/?lang=ka' : '/' + locale});
});

router.get('/terms', asyncHandler(async (req, res) => {
  if (redirectToCookieLocale(req, res, '/terms')) return;
  resolveLocale(req, res, '/terms');
  res.render('terms', { legalDoc: await legalContentService.getTerms(), ...LEGAL_LOCALS });
}));

router.get('/privacy', asyncHandler(async (req, res) => {
  if (redirectToCookieLocale(req, res, '/privacy')) return;
  resolveLocale(req, res, '/privacy');
  res.render('privacy', { legalDoc: await legalContentService.getPrivacy(), ...LEGAL_LOCALS });
}));

module.exports = router;
