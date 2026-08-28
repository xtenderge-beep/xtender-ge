const redis = require('../config/redis');
const adminAuth = require('../config/adminAuth');
const pool = require('../config/db');
const masterService = require('../services/master.service');
const adminService = require('../services/admin.service');
const reviewService = require('../services/review.service');

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
  res.render('admin/master-detail', { master, history, responseStats, error: req.query.error || null });
}

async function approveMaster(req, res) {
  const id = parseInt(req.params.id, 10);
  await masterService.approveMaster(id);
  res.redirect('/admin/masters');
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

async function reviewsQueue(req, res) {
  const pending = await reviewService.listPending();
  res.render('admin/reviews', { pending });
}

async function approveReview(req, res) {
  await reviewService.approve(parseInt(req.params.id, 10));
  res.redirect('/admin/reviews');
}

async function rejectReview(req, res) {
  await reviewService.reject(parseInt(req.params.id, 10));
  res.redirect('/admin/reviews');
}

module.exports = {
  showLogin,
  login,
  logout,
  overview,
  mastersList,
  masterDetail,
  approveMaster,
  banMaster,
  unbanMaster,
  correctBalance,
  ordersList,
  orderDetail,
  reviewsQueue,
  approveReview,
  rejectReview,
};
