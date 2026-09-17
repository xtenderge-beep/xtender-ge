const orderService = require('../services/order.service');
const reviewService = require('../services/review.service');
const otpService = require('../services/otp.service');
const redis = require('../config/redis');
const { clientStrings } = require('../config/i18n');
const { phoneVariants } = require('../config/phone');
const { requestMeta } = require('../config/requestMeta');
const legalContentService = require('../services/legalContent.service');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 3600;
const { isGeorgianPhone, georgianPhoneError } = require('../config/phone');
const REVIEW_PURPOSE = 'review';

async function checkRateLimit(scope) {
  const key = `review_submit_limit:${scope}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
  return count <= RATE_LIMIT_MAX;
}

// --- Флоу по SMS-ссылке после закрытия заявки (/review/:ownerToken) ---

async function showInvite(req, res) {
  const order = await orderService.getOrderByOwnerToken(req.params.ownerToken);
  if (!order) {
    return res.status(404).render('review', { order: null, masters: [], clientStrings: clientStrings(req.lang) });
  }
  const masters = await reviewService.getEligibleMasters(order.id);
  res.render('review', { order, masters, clientStrings: clientStrings(req.lang) });
}

// --- Флоу «оставить отзыв из каталога» (кнопка на карточке мастера) ---

async function requestCode(req, res) {
  const phone = (typeof req.body.phone === 'string' ? req.body.phone : '').replace(/\s+/g, '');
  if (!phone || !isGeorgianPhone(phone)) {
    return res.status(400).json({ success: false, message: georgianPhoneError(req.lang) });
  }

  const result = await otpService.sendCode(phone, null, REVIEW_PURPOSE, null, { meta: requestMeta(req) });
  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }
  return res.json({ success: true });
}

async function verifyForMaster(req, res) {
  const phone = (typeof req.body.phone === 'string' ? req.body.phone : '').replace(/\s+/g, '');
  const { code } = req.body;
  const masterId = parseInt(req.body.masterId, 10);

  if (!phone || !isGeorgianPhone(phone) || !code || !Number.isInteger(masterId)) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  const { version: termsVersion } = await legalContentService.getTerms();
  const ok = await otpService.verifyCode(phone, code, REVIEW_PURPOSE, {
    meta: requestMeta(req),
    language: req.lang,
    termsVersion,
  });
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid or expired code' });

  const variants = phoneVariants(phone);
  const order = await reviewService.findReviewableOrder(variants, masterId);
  if (order) return res.json({ success: true, eligible: true });

  const already = await reviewService.hasReviewFromPhone(variants, masterId);
  return res.json({ success: true, eligible: false, reason: already ? 'already_reviewed' : 'not_eligible' });
}

// --- Отправка отзыва (общая точка для обоих флоу) ---

async function submit(req, res) {
  const { ownerToken, comment } = req.body;
  const ratingNum = parseInt(req.body.rating, 10);
  const masterIdNum = parseInt(req.body.masterId, 10);

  if (!Number.isInteger(masterIdNum) || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  let orderId;
  let verifiedPhone = null;

  if (ownerToken) {
    if (!(await checkRateLimit(`token:${ownerToken}`))) {
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
    const order = await orderService.getOrderByOwnerToken(ownerToken);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!(await reviewService.isMasterEligible(order.id, masterIdNum))) {
      return res.status(403).json({ success: false, message: 'Master not eligible for this order' });
    }
    orderId = order.id;
  } else {
    const phone = (typeof req.body.phone === 'string' ? req.body.phone : '').replace(/\s+/g, '');
    if (!phone || !isGeorgianPhone(phone)) {
      return res.status(400).json({ success: false, message: georgianPhoneError(req.lang) });
    }
    if (!(await otpService.isPhoneVerified(phone, REVIEW_PURPOSE))) {
      return res.status(403).json({ success: false, message: 'Phone not verified' });
    }
    if (!(await checkRateLimit(`phone:${phone}`))) {
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
    const order = await reviewService.findReviewableOrder(phoneVariants(phone), masterIdNum);
    if (!order) return res.status(403).json({ success: false, message: 'Not eligible' });
    orderId = order.id;
    verifiedPhone = phone;
  }

  const review = await reviewService.submitReview({
    orderId,
    masterId: masterIdNum,
    rating: ratingNum,
    comment: (comment || '').trim().slice(0, 1000),
  });
  if (!review) return res.status(409).json({ success: false, message: 'Already reviewed' });

  if (verifiedPhone) await otpService.clearVerified(verifiedPhone, REVIEW_PURPOSE);

  return res.json({ success: true });
}

module.exports = { showInvite, requestCode, verifyForMaster, submit };
