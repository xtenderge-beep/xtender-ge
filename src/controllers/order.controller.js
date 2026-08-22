const orderService = require('../services/order.service');
const otpService = require('../services/otp.service');
const { clientStrings } = require('../config/i18n');

const PHONE_REGEX = /^\+?\d{9,15}$/;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_CATEGORIES = new Set(['transport', 'movers', 'junk']);

function ownerCookieName(token) {
  return `order_${token}`;
}

async function create(req, res) {
  const { phone, description, districtName } = req.body;

  if (!phone || !PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ success: false, message: 'Description is required' });
  }

  const rawCategories = Array.isArray(req.body.targetCategories)
    ? req.body.targetCategories
    : req.body.targetCategories
      ? [req.body.targetCategories]
      : [];
  const targetCategories = [...new Set(rawCategories.filter((c) => ALLOWED_CATEGORIES.has(c)))];
  if (!targetCategories.length) {
    return res.status(400).json({ success: false, message: 'At least one service must be selected' });
  }

  const verified = await otpService.isPhoneVerified(phone);
  if (!verified) {
    return res.status(400).json({ success: false, message: 'Phone not verified' });
  }

  const order = await orderService.createOrder({
    phone,
    description,
    districtName: districtName || '',
    targetCategories,
  });
  await otpService.clearVerified(phone);
  await orderService.attachFiles(order.id, req.files);

  res.cookie(ownerCookieName(order.token), '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });

  orderService.notifyMasters(order, order.target_categories).catch((err) => {
    console.error('Failed to notify masters:', err.message);
  });

  return res.json({ success: true, token: order.token });
}

async function show(req, res) {
  const { token } = req.params;
  const order = await orderService.getOrderByToken(token);

  if (!order) {
    return res.status(404).render('order', {
      order: null,
      files: [],
      isOwner: false,
      masterId: null,
      clientStrings: clientStrings(req.lang),
    });
  }

  const isOwner = req.cookies[ownerCookieName(token)] === '1';
  const masterId = req.query.master || null;
  const files = await orderService.getOrderFiles(order.id);

  return res.render('order', {
    order,
    files,
    isOwner,
    masterId,
    clientStrings: clientStrings(req.lang),
  });
}

async function close(req, res) {
  const { token } = req.params;
  const isOwner = req.cookies[ownerCookieName(token)] === '1';

  if (!isOwner) {
    return res.status(403).json({ success: false, message: 'Not allowed' });
  }

  const order = await orderService.closeOrder(token);

  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  return res.json({ success: true, message: 'Order closed' });
}

async function logView(req, res) {
  const { token } = req.params;
  const { masterId } = req.body;

  if (!masterId) {
    return res.status(400).json({ success: false, message: 'masterId is required' });
  }

  const order = await orderService.getOrderByToken(token);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  await orderService.logView(order.id, masterId);

  return res.json({ success: true });
}

module.exports = {
  create,
  show,
  close,
  logView,
};
