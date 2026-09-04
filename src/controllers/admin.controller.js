const redis = require('../config/redis');
const adminAuth = require('../config/adminAuth');
const pool = require('../config/db');
const masterService = require('../services/master.service');
const adminService = require('../services/admin.service');
const reviewService = require('../services/review.service');
const orderService = require('../services/order.service');
const telegramService = require('../services/telegram.service');
const supportService = require('../services/support.service');
const promoService = require('../services/promo.service');
const managerService = require('../services/manager.service');
const consentLogService = require('../services/consentLog.service');
const settingsService = require('../services/settings.service');
const { toE164 } = require('../config/phone');

const ALLOWED_CATEGORIES = new Set(['transport', 'movers', 'junk']);
const ALLOWED_SIZES = new Set(['L', 'XL', 'XXL']);

const LOGIN_RATE_LIMIT_MAX = 10;
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

async function checkLoginRateLimit(ip) {
  const key = `admin_login_limit:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, LOGIN_RATE_LIMIT_WINDOW_SECONDS);
  }
  return count <= LOGIN_RATE_LIMIT_MAX;
}

function showLogin(req, res) {
  res.render('admin/login', { error: null });
}

async function login(req, res) {
  const allowed = await checkLoginRateLimit(req.ip);
  if (!allowed) {
    return res.status(429).render('admin/login', { error: 'Слишком много попыток. Попробуйте позже.' });
  }

  if (!adminAuth.verifyPassword(req.body.password || '')) {
    return res.status(401).render('admin/login', { error: 'Неверный пароль' });
  }

  const session = adminAuth.createSessionValue();
  res.cookie(adminAuth.SESSION_COOKIE, session.cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    expires: new Date(session.expiresAt),
  });
  res.redirect('/admin');
}

function logout(req, res) {
  res.clearCookie(adminAuth.SESSION_COOKIE);
  res.redirect('/admin/login');
}

async function overview(req, res) {
  const stats = await adminService.getOverviewStats();
  res.render('admin/overview', { stats });
}

async function mastersList(req, res) {
  const masters = await adminService.listMastersAdmin();
  res.render('admin/masters', { masters });
}

async function masterDetail(req, res) {
  const id = parseInt(req.params.id, 10);
  const master = await adminService.getMasterDetail(id);
  if (!master) return res.status(404).send('Мастер не найден');
  const history = await adminService.getMasterBalanceHistory(id);
  const responseStats = await adminService.getResponseStats(id);
  const promoOrigin = master.promo_code_used ? await promoService.getCode(master.promo_code_used) : null;
  const managers = await managerService.list();
  const currentManager = master.manager_id ? await managerService.getById(master.manager_id) : null;
  res.render('admin/master-detail', {
    master, history, responseStats, promoOrigin, managers, currentManager, error: req.query.error || null,
  });
}

async function approveMaster(req, res) {
  const id = parseInt(req.params.id, 10);
  await masterService.approveMaster(id);
  res.redirect('/admin/masters');
}

async function updateMaster(req, res) {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const phoneRaw = (req.body.phone || '').trim();
  const category = req.body.category;
  const vehicleType = (req.body.vehicleType || '').trim();
  const priceText = (req.body.priceText || '').trim();
  const description = (req.body.description || '').trim();

  if (!name || !phoneRaw || !ALLOWED_CATEGORIES.has(category)) {
    return res.redirect(`/admin/masters/${id}?error=invalid_fields`);
  }

  const vehicleSize = category === 'transport' && ALLOWED_SIZES.has(req.body.vehicleSize) ? req.body.vehicleSize : null;
  const isFlatbed = category === 'transport' && req.body.isFlatbed === 'on';

  try {
    await masterService.updateMasterProfile(id, {
      name,
      phone: toE164(phoneRaw),
      category,
      vehicleType,
      vehicleSize,
      isFlatbed,
      priceText,
      description,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect(`/admin/masters/${id}?error=phone_taken`);
    }
    throw err;
  }

  res.redirect(`/admin/masters/${id}`);
}

async function banMaster(req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = (req.body.reason || '').trim() || null;
  await adminService.setMasterBanned(id, true, reason);
  res.redirect(`/admin/masters/${id}`);
}

async function unbanMaster(req, res) {
  const id = parseInt(req.params.id, 10);
  await adminService.setMasterBanned(id, false, null);
  res.redirect(`/admin/masters/${id}`);
}

async function correctBalance(req, res) {
  const id = parseInt(req.params.id, 10);
  const amountGel = parseFloat(String(req.body.amountGel || '').replace(',', '.'));
  if (!Number.isFinite(amountGel) || amountGel === 0) {
    return res.redirect(`/admin/masters/${id}?error=invalid_amount`);
  }
  const note = (req.body.note || '').trim() || null;
  await pool.withTransaction((client) =>
    masterService.adjustBalance(
      { masterId: id, amountTetri: Math.round(amountGel * 100), reason: 'admin_correction', note },
      client
    )
  );
  res.redirect(`/admin/masters/${id}`);
}

async function ordersList(req, res) {
  const orders = await adminService.listOrdersAdmin();
  res.render('admin/orders', { orders });
}

async function orderDetail(req, res) {
  const order = await adminService.getOrderDetailAdmin(req.params.token);
  if (!order) return res.status(404).send('Заявка не найдена');
  res.render('admin/order-detail', { order });
}

// Закрытие от лица модератора — намеренно без SMS клиенту с приглашением оценить
// исполнителя (в отличие от orderController.close): это административное действие,
// а не подтверждение клиента, что работа сделана.
async function closeOrder(req, res) {
  const { token } = req.params;
  const order = await orderService.closeOrder(token);
  if (!order) return res.status(404).send('Заявка не найдена');

  telegramService.updateMessage(order).catch((err) => {
    console.error('Failed to update Telegram message on admin close:', err.message);
  });

  res.redirect(`/admin/orders/${token}`);
}

async function reviewsQueue(req, res) {
  const pending = await reviewService.listPending();
  res.render('admin/reviews', { pending });
}

async function supportList(req, res) {
  const threads = await supportService.listThreads();
  res.render('admin/support', { threads });
}

async function supportThread(req, res) {
  const masterId = parseInt(req.params.masterId, 10);
  const master = await masterService.getMasterById(masterId);
  if (!master) return res.status(404).send('Исполнитель не найден');
  const messages = await supportService.listForMaster(masterId, 200);
  res.render('admin/support-thread', { master, messages });
}

async function supportReply(req, res) {
  const masterId = parseInt(req.params.masterId, 10);
  const body = (req.body.body || '').trim().slice(0, 2000);
  if (body) await supportService.postModeratorReply(masterId, body);
  res.redirect(`/admin/support/${masterId}`);
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

async function promoList(req, res) {
  const codes = await promoService.listCodes();
  res.render('admin/promo', { codes, error: req.query.error || null, baseUrl: baseUrl(req) });
}

async function promoCreate(req, res) {
  let code = (req.body.code || '').trim().toUpperCase();
  const amountGel = parseFloat(String(req.body.amountGel || '').replace(',', '.'));
  const maxRedemptions = req.body.maxRedemptions ? parseInt(req.body.maxRedemptions, 10) : null;
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const label = (req.body.label || '').trim().slice(0, 120) || null;

  if (!Number.isFinite(amountGel) || amountGel <= 0) {
    return res.redirect('/admin/promo?error=invalid');
  }
  if (!code) code = await promoService.generateCode(); // пустой код → генерируем сами
  else if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return res.redirect('/admin/promo?error=invalid');
  if (maxRedemptions !== null && (!Number.isFinite(maxRedemptions) || maxRedemptions < 1)) {
    return res.redirect('/admin/promo?error=invalid');
  }

  await promoService.createCode({
    code,
    amountTetri: Math.round(amountGel * 100),
    maxRedemptions,
    expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
    label,
  });
  res.redirect('/admin/promo');
}

async function promoDetail(req, res) {
  const stats = await promoService.getCodeStats((req.params.code || '').toUpperCase());
  if (!stats) return res.status(404).send('Промокод не найден');
  res.render('admin/promo-detail', { stats, baseUrl: baseUrl(req) });
}

async function managersList(req, res) {
  const managers = await managerService.list();
  res.render('admin/managers', { managers, error: req.query.error || null });
}

async function managerCreate(req, res) {
  const name = (req.body.name || '').trim();
  const phoneRaw = (req.body.phone || '').trim();
  if (!name || !/^\+?\d{9,15}$/.test(phoneRaw.replace(/\s+/g, ''))) {
    return res.redirect('/admin/managers?error=invalid');
  }
  await managerService.create({ name, phone: phoneRaw, isModerator: req.body.isModerator === 'on' });
  res.redirect('/admin/managers');
}

async function managerUpdate(req, res) {
  const id = parseInt(req.params.id, 10);
  await managerService.update(id, {
    isModerator: req.body.isModerator === 'true',
    isActive: req.body.isActive === 'true',
  });
  res.redirect('/admin/managers');
}

async function managerDetail(req, res) {
  const id = parseInt(req.params.id, 10);
  const manager = await managerService.getById(id);
  if (!manager) return res.status(404).send('Менеджер не найден');
  const stats = await managerService.getStats(id);
  res.render('admin/manager-detail', { manager, stats, baseUrl: baseUrl(req) });
}

async function assignManager(req, res) {
  const masterId = parseInt(req.params.id, 10);
  const managerId = req.body.managerId ? parseInt(req.body.managerId, 10) : null;
  await managerService.assignProvider(masterId, managerId);
  res.redirect(`/admin/masters/${masterId}`);
}

async function promoToggle(req, res) {
  const id = parseInt(req.params.id, 10);
  await promoService.setActive(id, req.body.active === 'true');
  res.redirect('/admin/promo');
}

async function approveReview(req, res) {
  await reviewService.approve(parseInt(req.params.id, 10));
  res.redirect('/admin/reviews');
}

// Журнал согласий на SMS. Без ?phone — последние подтверждённые согласия;
// с ?phone — все события журнала по этому номеру + карточка Double Opt-In.
async function consentLog(req, res) {
  const phoneQuery = (req.query.phone || '').trim();
  const report = phoneQuery ? await consentLogService.exportForPhone(phoneQuery) : null;
  const recent = phoneQuery ? [] : await consentLogService.listRecentConsents(150);
  res.render('admin/consent', { phoneQuery, report, recent });
}

// Та же выгрузка, что отдаёт scripts/export-consent-log.js — скачивается файлом
// для официального ответа регулятору (PDPS) или SMS-оператору.
async function consentExport(req, res) {
  const phoneQuery = (req.query.phone || '').trim();
  if (!phoneQuery) return res.status(400).send('phone query param required');

  const report = await consentLogService.exportForPhone(phoneQuery);
  const safe = phoneQuery.replace(/[^\d]/g, '') || 'unknown';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sms-consent-${safe}.json"`);
  res.send(JSON.stringify(report, null, 2));
}

async function rejectReview(req, res) {
  await reviewService.reject(parseInt(req.params.id, 10));
  res.redirect('/admin/reviews');
}

// Настройки приложения — сейчас только цена лида (app_settings.lead_price_tetri),
// которую раньше можно было поменять только правкой кода и деплоем.
async function settingsPage(req, res) {
  const leadPriceTetri = await settingsService.getLeadPriceTetri();
  res.render('admin/settings', { leadPriceTetri, error: req.query.error || null, saved: req.query.saved === '1' });
}

async function updateLeadPrice(req, res) {
  const tetri = parseInt(req.body.leadPriceTetri, 10);
  if (!Number.isInteger(tetri) || tetri <= 0 || tetri > 10000) {
    return res.redirect('/admin/settings?error=invalid');
  }
  await settingsService.setLeadPriceTetri(tetri);
  res.redirect('/admin/settings?saved=1');
}

module.exports = {
  showLogin,
  login,
  logout,
  overview,
  mastersList,
  masterDetail,
  updateMaster,
  approveMaster,
  banMaster,
  unbanMaster,
  correctBalance,
  ordersList,
  orderDetail,
  closeOrder,
  reviewsQueue,
  approveReview,
  rejectReview,
  consentLog,
  consentExport,
  supportList,
  supportThread,
  supportReply,
  promoList,
  promoCreate,
  promoDetail,
  promoToggle,
  managersList,
  managerCreate,
  managerUpdate,
  managerDetail,
  assignManager,
  settingsPage,
  updateLeadPrice,
};
