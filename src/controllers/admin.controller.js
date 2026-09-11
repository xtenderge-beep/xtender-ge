const topupService = require('../services/topup.service');
const dispatchService = require('../services/dispatch.service');
const receiptService = require('../services/receipt.service');
const redis = require('../config/redis');
const adminAuth = require('../config/adminAuth');
const otpService = require('../services/otp.service');
const { requestMeta } = require('../config/requestMeta');
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

// junk оставлен для легаси-профилей; tow/bucket_lift — чтобы редактирование профиля
// нового типа в админке не сбрасывало category (полноценная форма из конфига — Фаза 5).
const ALLOWED_CATEGORIES = new Set(['transport', 'movers', 'junk', 'tow', 'bucket_lift']);
const ALLOWED_SIZES = new Set(['S', 'L', 'XL', 'XXL']);

const LOGIN_RATE_LIMIT_MAX = 10; // на один IP
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
// Лимит по IP легко обходится перебором с разных адресов (ботнет/прокси-пул) — общий
// счётчик поверх него ловит именно распределённый перебор пароля, откуда бы он ни шёл.
const LOGIN_RATE_LIMIT_GLOBAL_MAX = 30;
const LOGIN_ALERT_THROTTLE_SECONDS = 15 * 60; // не спамить в Telegram чаще раза в окно

async function incrWithExpiry(key, windowSeconds) {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count;
}

async function checkLoginRateLimit(ip) {
  const [ipCount, globalCount] = await Promise.all([
    incrWithExpiry(`admin_login_limit:${ip}`, LOGIN_RATE_LIMIT_WINDOW_SECONDS),
    incrWithExpiry('admin_login_limit:global', LOGIN_RATE_LIMIT_WINDOW_SECONDS),
  ]);
  const allowed = ipCount <= LOGIN_RATE_LIMIT_MAX && globalCount <= LOGIN_RATE_LIMIT_GLOBAL_MAX;
  if (!allowed) {
    const alreadyAlerted = await redis.get('admin_login_alert_sent');
    if (!alreadyAlerted) {
      await redis.set('admin_login_alert_sent', '1', 'EX', LOGIN_ALERT_THROTTLE_SECONDS);
      telegramService
        .sendSecurityAlert(`⚠️ /admin: превышен лимит попыток входа (IP ${ip}). Похоже на подбор пароля.`)
        .catch(() => {});
    }
  }
  return allowed;
}

const ADMIN_OTP_PURPOSE = 'admin';
// Окно то же, что у pending-куки (10 мин) — после истечения кода всё равно придётся
// начинать заново с пароля, отдельный TTL только запутал бы.
const ADMIN_2FA_ATTEMPT_MAX = 8;
const ADMIN_2FA_ATTEMPT_WINDOW_SECONDS = 10 * 60;

const cookieOpts = (expiresAt) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV !== 'development',
  expires: new Date(expiresAt),
});

function showLogin(req, res) {
  res.render('admin/login', { error: null });
}

function issueAdminSession(req, res, viaText) {
  const session = adminAuth.createSessionValue();
  res.cookie(adminAuth.SESSION_COOKIE, session.cookieValue, cookieOpts(session.expiresAt));
  telegramService
    .sendSecurityAlert(`✅ Вход в /admin (${viaText})\nIP: ${req.ip}\nUA: ${(req.get('user-agent') || '—').slice(0, 150)}`)
    .catch(() => {});
}

// Пароль подтверждён. Если SMS-2FA не включена (нет ADMIN_PHONE) — прежнее поведение,
// сессия выдаётся сразу. Если включена — либо это уже доверенное устройство (пропускаем
// код), либо шлём SMS и показываем экран ввода кода вместо кабинета.
async function login(req, res) {
  const allowed = await checkLoginRateLimit(req.ip);
  if (!allowed) {
    return res.status(429).render('admin/login', { error: 'Слишком много попыток. Попробуйте позже.' });
  }

  if (!adminAuth.verifyPassword(req.body.password || '')) {
    return res.status(401).render('admin/login', { error: 'Неверный пароль' });
  }

  if (!adminAuth.is2faEnabled()) {
    issueAdminSession(req, res, 'пароль');
    return res.redirect('/admin');
  }

  if (adminAuth.verifyTrustedDevice(req.cookies[adminAuth.TRUSTED_DEVICE_COOKIE])) {
    issueAdminSession(req, res, 'пароль, доверенное устройство');
    return res.redirect('/admin');
  }

  const phone = toE164(process.env.ADMIN_PHONE);
  const sent = await otpService.sendCode(phone, null, ADMIN_OTP_PURPOSE, null, { meta: requestMeta(req) });
  if (!sent.success) {
    return res.status(500).render('admin/login', { error: 'Не удалось отправить SMS-код. Попробуйте позже.' });
  }

  const pending = adminAuth.createPending2fa();
  res.cookie(adminAuth.PENDING_2FA_COOKIE, pending.cookieValue, cookieOpts(pending.expiresAt));
  res.render('admin/verify-2fa', { error: null, resent: false });
}

// Код из SMS ИЛИ резервный код из ADMIN_2FA_RECOVERY_CODE — любой из двух подходит,
// вводятся в одно и то же поле. Резервным кодом доверенное устройство НЕ создаём: раз
// его использовали, значит обычный путь (телефон) был недоступен, и мы не знаем,
// свой ли это компьютер — безопаснее спросить код ещё раз в следующий вход тоже.
async function verify2fa(req, res) {
  const pending = adminAuth.verifyPending2fa(req.cookies[adminAuth.PENDING_2FA_COOKIE]);
  if (!pending) {
    return res.redirect('/admin/login');
  }

  const attempts = await incrWithExpiry(`admin_2fa_attempts:${pending.nonce}`, ADMIN_2FA_ATTEMPT_WINDOW_SECONDS);
  if (attempts > ADMIN_2FA_ATTEMPT_MAX) {
    res.clearCookie(adminAuth.PENDING_2FA_COOKIE);
    telegramService.sendSecurityAlert(`⚠️ /admin: превышен лимит попыток ввода 2FA-кода (IP ${req.ip}).`).catch(() => {});
    return res.status(429).render('admin/login', { error: 'Слишком много неверных попыток. Войдите заново.' });
  }

  const code = (req.body.code || '').trim();
  const phone = toE164(process.env.ADMIN_PHONE);
  // recordConsent: false — это аутентификация владельца, а не согласие на SMS-рассылку,
  // не нужно писать строку в sms_consent_logs.
  const otpOk = Boolean(code) && (await otpService.verifyCode(phone, code, ADMIN_OTP_PURPOSE, { recordConsent: false }));
  const recoveryOk = !otpOk && adminAuth.verifyRecoveryCode(code);

  if (!otpOk && !recoveryOk) {
    return res.status(401).render('admin/verify-2fa', { error: 'Неверный код', resent: false });
  }

  res.clearCookie(adminAuth.PENDING_2FA_COOKIE);
  if (otpOk) {
    const trusted = adminAuth.createTrustedDevice();
    res.cookie(adminAuth.TRUSTED_DEVICE_COOKIE, trusted.cookieValue, cookieOpts(trusted.expiresAt));
  } else {
    telegramService
      .sendSecurityAlert(`⚠️ Вход в /admin через РЕЗЕРВНЫЙ код, не SMS. Если это не ты — срочно смени ADMIN_2FA_RECOVERY_CODE и ADMIN_PASSWORD в Railway.\nIP: ${req.ip}`)
      .catch(() => {});
  }
  issueAdminSession(req, res, otpOk ? 'SMS-код' : 'резервный код');
  res.redirect('/admin');
}

async function resend2fa(req, res) {
  const pending = adminAuth.verifyPending2fa(req.cookies[adminAuth.PENDING_2FA_COOKIE]);
  if (!pending) return res.redirect('/admin/login');

  const phone = toE164(process.env.ADMIN_PHONE);
  const sent = await otpService.sendCode(phone, null, ADMIN_OTP_PURPOSE, null, { meta: requestMeta(req) });
  if (!sent.success) {
    return res.render('admin/verify-2fa', { error: 'Не удалось отправить код повторно. Подождите немного.', resent: false });
  }
  res.render('admin/verify-2fa', { error: null, resent: true });
}

function logout(req, res) {
  res.clearCookie(adminAuth.SESSION_COOKIE);
  res.redirect('/admin/login');
}

async function overview(req, res) {
  const stats = await adminService.getOverviewStats();
  const orders = await adminService.listOrdersAdmin();
  const receiptCount = await pool.query("SELECT COUNT(*)::int AS count FROM topup_receipts WHERE status IN ('received','reviewing')");
  res.render('admin/overview', { stats, waitingOrders: orders.filter(o=>o.status !== 'closed' && !o.first_dispatched_at).length, waitingReceipts: receiptCount.rows[0].count });
}

async function mastersList(req, res) {
  const masters = await adminService.listMastersAdmin();
  res.render('admin/masters', { masters: req.query.status === 'pending' ? masters.filter(m=>!m.is_active && !m.is_banned) : masters });
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
  const q = String(req.query.q || '').trim().slice(0,100);
  const status = ['waiting','active','closed'].includes(req.query.status) ? req.query.status : '';
  const filtered = orders.filter(o=>(!q || [o.id,o.token,o.description,o.manager_name].join(' ').toLowerCase().includes(q.toLowerCase())) && (!status || (status === 'closed' ? o.status === 'closed' : status === 'waiting' ? o.status !== 'closed' && !o.first_dispatched_at : o.status !== 'closed' && o.first_dispatched_at)));
  const page = Math.min(Math.max(1, Math.ceil(filtered.length/30)), Math.max(1, parseInt(req.query.page,10)||1));
  res.render('admin/orders', { orders: filtered.slice((page-1)*30,page*30), q, status, page, total: filtered.length });
}

async function orderDetail(req, res) {
  const order = await adminService.getOrderDetailAdmin(req.params.token);
  if (!order) return res.status(404).send('Заявка не найдена');
  res.render('admin/order-detail', { order, groups: dispatchService.groups });
}

// Закрытие от лица модератора — намеренно без SMS клиенту с приглашением оценить
// исполнителя (в отличие от orderController.close): это административное действие,
// а не подтверждение клиента, что работа сделана.
async function closeOrder(req, res) {
  const { token } = req.params;
  const order = await orderService.closeOrder(token, { actor: 'admin', reason: 'admin_closed', meta: require('../config/requestMeta').requestMeta(req) });
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
  const [stats, clientFunnel] = await Promise.all([
    managerService.getStats(id),
    managerService.getClientFunnel(id),
  ]);
  res.render('admin/manager-detail', {
    manager, stats, clientFunnel, baseUrl: baseUrl(req),
    newInviteLink: req.query.link || null,
  });
}

async function managerClientLink(req, res) {
  const id = parseInt(req.params.id, 10);
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  if (!/^\+?\d{9,15}$/.test(phone)) {
    return res.redirect(`/admin/managers/${id}?error=phone`);
  }
  const token = await managerService.createClientInvite(id, phone);
  res.redirect(`/admin/managers/${id}?link=${encodeURIComponent(`${baseUrl(req)}/z/${token}`)}`);
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

// Настройки приложения: цена лида с рассылки (app_settings.lead_price_tetri) и цена
// раскрытия номера в публичном каталоге (catalog_call_price_tetri) — раньше первая была
// захардкожена в коде, второй канал монетизации вообще не существовал.
async function settingsPage(req, res) {
  const [leadPriceTetri, catalogCallPriceTetri, welcomeBonusTetri] = await Promise.all([
    settingsService.getLeadPriceTetri(),
    settingsService.getCatalogCallPriceTetri(),
    settingsService.getWelcomeBonusTetri(),
  ]);
  const paymentDetails = await topupService.getDetails();
  res.render('admin/settings', {
    paymentDetails,
    leadPriceTetri, catalogCallPriceTetri, welcomeBonusTetri,
    error: req.query.error || null, saved: req.query.saved || null,
  });
}

async function updateLeadPrice(req, res) {
  const tetri = parseInt(req.body.leadPriceTetri, 10);
  if (!Number.isInteger(tetri) || tetri <= 0 || tetri > 10000) {
    return res.redirect('/admin/settings?error=invalid_lead');
  }
  await settingsService.setLeadPriceTetri(tetri);
  res.redirect('/admin/settings?saved=lead');
}

async function updateCatalogCallPrice(req, res) {
  const tetri = parseInt(req.body.catalogCallPriceTetri, 10);
  if (!Number.isInteger(tetri) || tetri <= 0 || tetri > 10000) {
    return res.redirect('/admin/settings?error=invalid_catalog');
  }
  await settingsService.setCatalogCallPriceTetri(tetri);
  res.redirect('/admin/settings?saved=catalog');
}

async function receiptsList(req, res) {
  res.render('admin/receipts', { receipts: await receiptService.list(), error: null });
}
async function receiptReview(req, res) {
  try {
    await receiptService.review(Number(req.params.id), req.body.status, Number(req.body.transactionId), String(req.body.note || '').trim().slice(0, 500));
    res.redirect('/admin/receipts');
  } catch (error) {
    res.status(400).render('admin/receipts', { receipts: await receiptService.list(), error: error.message });
  }
}
async function dispatchPreview(req,res) {
  let plan=null, error=null;
  try { plan=await dispatchService.preview(req.params.token, req.query.category, req.query.size || ''); } catch(err) { error=err.message; }
  res.status(error ? 400 : 200).render('admin/dispatch',{token:req.params.token,plan,error,result:null,groups:dispatchService.groups});
}
async function dispatchOrder(req,res) {
  let result=null,error=null;
  try { result=await dispatchService.dispatch(req.params.token,req.body.category,req.body.size || '',{price:req.body.price,count:req.body.count}); } catch(err) { error=err.message; }
  res.status(error ? 409 : 200).render('admin/dispatch',{token:req.params.token,plan:null,error,result,groups:dispatchService.groups});
}
async function updateWelcomeBonus(req, res) {
  const raw = String(req.body.welcomeBonusGel || '').trim();
  const tetri = Math.round(Number(raw) * 100);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(tetri) || tetri < 0 || tetri > 100000) {
    return res.redirect('/admin/settings?error=invalid_welcome');
  }
  await settingsService.setWelcomeBonusTetri(tetri);
  res.redirect('/admin/settings?saved=welcome');
}
async function updatePaymentDetails(req,res) {
  try { await topupService.saveDetails(req.body); } catch(error) { return res.redirect('/admin/settings?error=payment'); }
  res.redirect('/admin/settings?saved=payment');
}
module.exports = {
  updatePaymentDetails,
  updateWelcomeBonus,
  dispatchPreview, dispatchOrder,
  receiptsList, receiptReview,
  showLogin,
  login,
  verify2fa,
  resend2fa,
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
  managerClientLink,
  assignManager,
  settingsPage,
  updateLeadPrice,
  updateCatalogCallPrice,
};
