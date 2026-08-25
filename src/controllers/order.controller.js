const orderService = require('../services/order.service');
const otpService = require('../services/otp.service');
const telegramService = require('../services/telegram.service');
const { clientStrings } = require('../config/i18n');

const PHONE_REGEX = /^\+?\d{9,15}$/;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_CATEGORIES = new Set(['transport', 'movers', 'junk', 'flatbed']);
const ALLOWED_SIZES = new Set(['L', 'XL', 'XXL']);
const MY_ORDERS_COOKIE = 'my_orders';
const MY_ORDERS_MAX = 20;

function ownerCookieName(token) {
  return `order_${token}`;
}

function readMyOrderTokens(req) {
  try {
    const raw = req.cookies[MY_ORDERS_COOKIE];
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberOrderToken(req, res, token) {
  const tokens = [token, ...readMyOrderTokens(req).filter((t) => t !== token)].slice(0, MY_ORDERS_MAX);
  res.cookie(MY_ORDERS_COOKIE, JSON.stringify(tokens), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

async function create(req, res) {
  const { token } = req.body;
  const phone = (req.body.phone || '').replace(/\s+/g, '');

  if (!phone || !PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: 'Order token is required' });
  }

  const verified = await otpService.isPhoneVerified(phone);
  if (!verified) {
    return res.status(400).json({ success: false, message: 'Phone not verified' });
  }

  const order = await orderService.activateOrder(token, phone);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  await otpService.clearVerified(phone);
  await orderService.attachFiles(order.id, req.files);

  res.cookie(ownerCookieName(order.token), '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
  rememberOrderToken(req, res, order.token);

  telegramService
    .notifyModerator(order)
    .then((messageId) => {
      if (messageId) return orderService.setModerationMessageId(order.id, messageId);
    })
    .catch((err) => {
      console.error('Failed to notify moderator:', err.message);
    });

  return res.json({ success: true, token: order.token });
}

async function telegramWebhook(req, res) {
  try {
    const update = req.body;
    const callback = update.callback_query;

    if (!callback || !callback.data || !callback.data.startsWith('cat:')) {
      return res.sendStatus(200);
    }

    const [, token, categoryRaw, sizeRaw] = callback.data.split(':');
    const category = ALLOWED_CATEGORIES.has(categoryRaw) ? categoryRaw : null;
    const vehicleSize = sizeRaw && ALLOWED_SIZES.has(sizeRaw) ? sizeRaw : null;

    if (!category) {
      await telegramService.answerCallback(callback.id, 'Некорректная категория');
      return res.sendStatus(200);
    }

    const order = await orderService.getOrderByToken(token);
    if (!order || order.status === 'closed') {
      await telegramService.answerCallback(callback.id, 'Заявка закрыта или не найдена');
      return res.sendStatus(200);
    }

    const isNewDispatch = await orderService.recordDispatch(order.id, category, vehicleSize);
    if (!isNewDispatch) {
      await telegramService.answerCallback(callback.id, 'Уже отправлено этой категории');
      return res.sendStatus(200);
    }

    await orderService.markFirstDispatch(token);

    const updatedOrder = await orderService.addTargetCategories(token, [category]);
    await telegramService.answerCallback(callback.id, 'Разослано исполнителям');

    const masterCount = await orderService.notifyMasters(updatedOrder, category, vehicleSize);
    console.log(`Dispatched order ${token} to ${masterCount} masters (${category}${vehicleSize ? ':' + vehicleSize : ''})`);

    telegramService.updateMessage(updatedOrder).catch((err) => {
      console.error('Failed to update Telegram message:', err.message);
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook handler failed:', err.message);
    return res.sendStatus(200);
  }
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
      funnel: null,
      clientStrings: clientStrings(req.lang),
    });
  }

  const isOwner = req.cookies[ownerCookieName(token)] === '1';
  const masterId = req.query.master || null;
  const files = await orderService.getOrderFiles(order.id);
  const funnel = isOwner ? await orderService.getOrderFunnelStats(order.id) : null;

  return res.render('order', {
    order,
    files,
    isOwner,
    masterId,
    funnel,
    clientStrings: clientStrings(req.lang),
  });
}

async function showByOwnerToken(req, res) {
  const { ownerToken } = req.params;
  const order = await orderService.getOrderByOwnerToken(ownerToken);

  if (!order) {
    return res.status(404).render('order', {
      order: null,
      files: [],
      isOwner: false,
      masterId: null,
      funnel: null,
      clientStrings: clientStrings(req.lang),
    });
  }

  res.cookie(ownerCookieName(order.token), '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
  rememberOrderToken(req, res, order.token);

  const files = await orderService.getOrderFiles(order.id);
  const funnel = await orderService.getOrderFunnelStats(order.id);

  return res.render('order', {
    order,
    files,
    isOwner: true,
    masterId: null,
    funnel,
    clientStrings: clientStrings(req.lang),
  });
}

async function myOrders(req, res) {
  const tokens = readMyOrderTokens(req);
  const orders = await orderService.getOrdersByTokens(tokens);
  return res.render('my-orders', {
    orders,
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

  telegramService.updateMessage(order).catch((err) => {
    console.error('Failed to update Telegram message on close:', err.message);
  });

  return res.json({ success: true, message: 'Order closed' });
}

const ALLOWED_EVENT_TYPES = new Set(['view', 'call', 'whatsapp']);

async function logView(req, res) {
  const { token } = req.params;
  const { masterId, eventType } = req.body;

  if (!masterId) {
    return res.status(400).json({ success: false, message: 'masterId is required' });
  }

  const order = await orderService.getOrderByToken(token);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const type = ALLOWED_EVENT_TYPES.has(eventType) ? eventType : 'view';
  await orderService.logView(order.id, masterId, type);
  telegramService.updateMessage(order).catch(() => {});

  return res.json({ success: true });
}

module.exports = {
  create,
  show,
  showByOwnerToken,
  close,
  logView,
  telegramWebhook,
  myOrders,
};
