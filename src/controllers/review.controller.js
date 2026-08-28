const orderService = require('../services/order.service');
const reviewService = require('../services/review.service');
const redis = require('../config/redis');
const { clientStrings } = require('../config/i18n');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

async function checkRateLimit(ownerToken) {
  const key = `review_submit_limit:${ownerToken}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
  return count <= RATE_LIMIT_MAX;
}

async function showInvite(req, res) {
  const order = await orderService.getOrderByOwnerToken(req.params.ownerToken);
  if (!order) {
    return res.status(404).render('review', { order: null, masters: [], clientStrings: clientStrings(req.lang) });
  }
  const masters = await reviewService.getEligibleMasters(order.id);
  res.render('review', { order, masters, clientStrings: clientStrings(req.lang) });
}

async function submit(req, res) {
  const { ownerToken, masterId, rating, comment } = req.body;
  const ratingNum = parseInt(rating, 10);
  const masterIdNum = parseInt(masterId, 10);

  if (!ownerToken || !Number.isInteger(masterIdNum) || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  const allowed = await checkRateLimit(ownerToken);
  if (!allowed) {
    return res.status(429).json({ success: false, message: 'Too many requests' });
  }

  const order = await orderService.getOrderByOwnerToken(ownerToken);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  const eligible = await reviewService.isMasterEligible(order.id, masterIdNum);
  if (!eligible) return res.status(403).json({ success: false, message: 'Master not eligible for this order' });

  const review = await reviewService.submitReview({
    orderId: order.id,
    masterId: masterIdNum,
    rating: ratingNum,
    comment: (comment || '').trim().slice(0, 1000),
  });
  if (!review) return res.status(409).json({ success: false, message: 'Already reviewed' });

  return res.json({ success: true });
}

module.exports = { showInvite, submit };
