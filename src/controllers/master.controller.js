const masterService = require('../services/master.service');
const reviewService = require('../services/review.service');
const otpService = require('../services/otp.service');
const telegramService = require('../services/telegram.service');
const smsService = require('../services/sms.service');
const promoService = require('../services/promo.service');
const supportService = require('../services/support.service');
const redis = require('../config/redis');
const { toE164 } = require('../config/phone');
const { getBaseUrl } = require('../config/url');
const { clientStrings } = require('../config/i18n');
const { requestMeta } = require('../config/requestMeta');
const { TERMS_VERSION, consentSnapshot } = require('../config/legal');
const payment = require('../config/payment');

const PHONE_REGEX = /^\+?\d{9,15}$/;
// В синхроне с order.service COST_PER_NOTIFICATION_TETRI.
const LEAD_PRICE_TETRI = 30;
const RECEIPT_RATE_MAX = 5;
const RECEIPT_RATE_WINDOW_SECONDS = 3600;
const MASTER_LOGIN_PURPOSE = 'master_login';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'xtendergebot';
// «Запомнить на устройстве»: httpOnly-cookie с master_token. Та же модель, что у
// owner_token заявки и cookie my_orders клиента — не сессия, просто чтобы не гонять
// через телефон+SMS каждый заход. 30 дней, как у остальных cookie.
const MASTER_COOKIE = 'master_session';
const MASTER_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_CATEGORIES = new Set(['movers', 'transport']);
const ALLOWED_BODY_TYPES = new Set(['closed', 'flatbed']);
const BODY_TYPE_LABELS = { closed: 'закрытый кузов', flatbed: 'борт (открытый)' };
const OTP_PURPOSE = 'master';

function parseCargoDimension(value) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function buildVehicleType({ vehicleType, cargoLength, cargoWidth, cargoHeight, bodyType }) {
  const parts = [];
  if (vehicleType) parts.push(vehicleType);
  if (cargoLength && cargoWidth && cargoHeight) parts.push(`${cargoLength}×${cargoWidth}×${cargoHeight} см`);
  if (bodyType) parts.push(BODY_TYPE_LABELS[bodyType]);
  return parts.length ? parts.join(', ') : null;
}

async function list(req, res) {
  const { category } = req.query;
  const masters = await masterService.listMasters({ category });
  return res.json({ success: true, masters });
}

async function sendOtp(req, res) {
  const rawPhone = (req.body.phone || '').replace(/\s+/g, '');
  if (!rawPhone || !PHONE_REGEX.test(rawPhone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const result = await otpService.sendCode(toE164(rawPhone), null, OTP_PURPOSE, null, { meta: requestMeta(req) });
  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests, try again later' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }

  return res.json({ success: true, message: 'Code sent' });
}

async function verifyOtp(req, res) {
  const rawPhone = (req.body.phone || '').replace(/\s+/g, '');
  const { code } = req.body;

  if (!rawPhone || !PHONE_REGEX.test(rawPhone) || !code) {
    return res.status(400).json({ success: false, message: 'Invalid phone or code' });
  }

  // strict: запись согласия на SMS обязательна — если журнал недоступен, регистрацию
  // считаем несостоявшейся (см. ТЗ Double Opt-In). Текст согласия снимаем на сервере.
  const isValid = await otpService.verifyCode(toE164(rawPhone), code, OTP_PURPOSE, {
    meta: requestMeta(req),
    language: req.lang,
    termsVersion: TERMS_VERSION,
    consentText: consentSnapshot(req.lang),
    strict: true,
  });
  if (!isValid) {
    return res.status(400).json({ success: false, message: 'Invalid or expired code' });
  }

  return res.json({ success: true, message: 'Verified' });
}

async function register(req, res) {
  const rawPhone = (req.body.phone || '').replace(/\s+/g, '');
  const name = (req.body.name || '').trim();
  const category = req.body.category;
  const vehicleTypeInput = (req.body.vehicleType || '').trim();
  const cargoLength = parseCargoDimension(req.body.cargoLength);
  const cargoWidth = parseCargoDimension(req.body.cargoWidth);
  const cargoHeight = parseCargoDimension(req.body.cargoHeight);
  const bodyType = req.body.bodyType || null;
  const description = (req.body.description || '').trim();
  const termsAccepted = Boolean(req.body.termsAccepted);

  if (!rawPhone || !PHONE_REGEX.test(rawPhone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!name) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }
  if (!ALLOWED_CATEGORIES.has(category)) {
    return res.status(400).json({ success: false, message: 'Invalid category' });
  }
  if (bodyType && !ALLOWED_BODY_TYPES.has(bodyType)) {
    return res.status(400).json({ success: false, message: 'Invalid body type' });
  }
  if (!termsAccepted) {
    return res.status(400).json({ success: false, message: 'Terms must be accepted' });
  }

  const phone = toE164(rawPhone);
  const verified = await otpService.isPhoneVerified(phone, OTP_PURPOSE);
  if (!verified) {
    return res.status(400).json({ success: false, message: 'Phone not verified' });
  }

  const master = await masterService.registerMaster({
    name,
    phone,
    category,
    vehicleType: category === 'transport'
      ? buildVehicleType({ vehicleType: vehicleTypeInput, cargoLength, cargoWidth, cargoHeight, bodyType })
      : null,
    vehicleSize: null,
    priceText: null,
    description,
  });
  await otpService.clearVerified(phone, OTP_PURPOSE);

  // Промокод: welcome-бонус на баланс. Ошибка/невалидный код не ломает регистрацию.
  let promoBonusGel = 0;
  const promoInput = (req.body.promoCode || '').trim().toUpperCase();
  if (promoInput) {
    try {
      const bonusTetri = await promoService.apply(master.id, promoInput);
      if (bonusTetri) promoBonusGel = bonusTetri / 100;
    } catch (err) {
      console.error('Promo apply failed:', err.message);
    }
  }

  const link = `${getBaseUrl()}/master/${master.master_token}`;

  telegramService.notifyModeratorNewMaster(master).catch((err) => {
    console.error('Failed to notify moderator about new master:', err.message);
  });
  smsService.sendOrderNotification(
    phone,
    `Xtender: заявка на регистрацию принята. Ваш баланс: ${link}`,
    { masterId: master.id, purpose: OTP_PURPOSE, meta: requestMeta(req) }
  ).catch((err) => {
    console.error('Failed to send registration confirmation SMS:', err.message);
  });

  return res.json({ success: true, link, promoBonusGel });
}

// Личный кабинет исполнителя — /master/<master_token>. Ссылка постоянная, приходит
// в SMS после регистрации; на неё же ведёт плашка со страницы каждого лида.
// Без токена (/master) или с невалидным — та же вьюха показывает вход по телефону.
async function statusPage(req, res) {
  const strings = clientStrings(req.lang);

  // /master без токена, но устройство помнит вход — сразу в кабинет, без телефона и SMS.
  if (!req.params.token && req.cookies[MASTER_COOKIE]) {
    const remembered = await masterService.getMasterByToken(req.cookies[MASTER_COOKIE]);
    if (remembered) return res.redirect(`/master/${remembered.master_token}`);
    res.clearCookie(MASTER_COOKIE); // токен протух — забываем
  }

  const master = req.params.token ? await masterService.getMasterByToken(req.params.token) : null;

  if (!master) {
    const badToken = Boolean(req.params.token);
    return res.status(badToken ? 404 : 200).render('master-status', {
      master: null, badToken, reviews: [], activity: null, history: [], leads: [], supportMessages: [],
      leadPriceTetri: LEAD_PRICE_TETRI, payment, botUsername: BOT_USERNAME, clientStrings: strings,
    });
  }

  // Открыл кабинет по токену (SMS-ссылка, после входа, закладка) — запоминаем устройство.
  res.cookie(MASTER_COOKIE, master.master_token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MASTER_COOKIE_MAX_AGE_MS,
  });

  const [reviews, activity, history, leads, supportMessages] = await Promise.all([
    reviewService.listApprovedForMasters([master.id]),
    masterService.getMasterActivity(master.id),
    masterService.getMasterBalanceHistory(master.id),
    masterService.getMasterLeads(master.id),
    supportService.listForMaster(master.id),
  ]);

  res.render('master-status', {
    master, badToken: false, reviews, activity, history, leads, supportMessages,
    leadPriceTetri: LEAD_PRICE_TETRI, payment, botUsername: BOT_USERNAME, clientStrings: strings,
  });
}

const SUPPORT_RATE_MAX = 15;
const SUPPORT_RATE_WINDOW_SECONDS = 3600;
const PROMO_RATE_MAX = 10;
const PROMO_RATE_WINDOW_SECONDS = 3600;

// Активация промокода из кабинета — для тех, кто не ввёл его при регистрации
// (опечатался, получил код позже). Одно применение на профиль (promo_code_used).
async function activatePromo(req, res) {
  const master = await masterService.getMasterByToken(req.params.token);
  if (!master) return res.status(404).json({ success: false });
  if (master.is_banned) return res.status(403).json({ success: false });
  if (master.promo_code_used) return res.json({ success: false, reason: 'already' });

  const code = (req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return res.status(400).json({ success: false, reason: 'invalid' });

  const key = `promo_rate:${master.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, PROMO_RATE_WINDOW_SECONDS);
  if (count > PROMO_RATE_MAX) return res.status(429).json({ success: false, reason: 'rate' });

  const bonusTetri = await promoService.apply(master.id, code);
  if (!bonusTetri) return res.json({ success: false, reason: 'invalid' });
  return res.json({ success: true, bonusGel: bonusTetri / 100 });
}

async function sendSupportMessage(req, res) {
  const master = await masterService.getMasterByToken(req.params.token);
  if (!master) return res.status(404).json({ success: false, message: 'Not found' });

  const body = (req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ success: false, message: 'Empty message' });

  const key = `support_rate:${master.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, SUPPORT_RATE_WINDOW_SECONDS);
  if (count > SUPPORT_RATE_MAX) return res.status(429).json({ success: false, message: 'Too many messages' });

  await supportService.forwardQuestion(master, body);
  return res.json({ success: true });
}

// «Выйти» из кабинета на общем устройстве — чистим cookie запоминания.
function logout(req, res) {
  res.clearCookie(MASTER_COOKIE);
  res.redirect('/');
}

// Вход в кабинет по телефону: код отправляем только если на номер есть профиль.
async function loginRequestCode(req, res) {
  const phone = toE164((req.body.phone || '').replace(/\s+/g, ''));
  if (!PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const master = await masterService.getMasterByPhone(phone);
  if (!master) {
    return res.status(404).json({ success: false, message: 'not_registered' });
  }

  const result = await otpService.sendCode(phone, null, MASTER_LOGIN_PURPOSE, null, { meta: requestMeta(req) });
  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }
  return res.json({ success: true });
}

async function loginVerify(req, res) {
  const phone = toE164((req.body.phone || '').replace(/\s+/g, ''));
  const { code } = req.body;
  if (!PHONE_REGEX.test(phone) || !code) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  const master = await masterService.getMasterByPhone(phone);

  const ok = await otpService.verifyCode(phone, code, MASTER_LOGIN_PURPOSE, {
    meta: requestMeta(req),
    language: req.lang,
    masterId: master && master.id,
  });
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid or expired code' });

  if (!master || !master.master_token) {
    return res.status(404).json({ success: false, message: 'not_registered' });
  }

  await otpService.clearVerified(phone, MASTER_LOGIN_PURPOSE);
  return res.json({ success: true, link: `/master/${master.master_token}` });
}

// Исполнитель прикрепляет чек о банковском переводе — файл уходит модератору в
// Telegram (sendPhoto/sendDocument по URL из public/uploads). Начисление баланса
// остаётся ручным: модератор смотрит чек и делает /topup.
async function unlinkTelegram(req, res) {
  const master = await masterService.getMasterByToken(req.params.token);
  if (!master) return res.status(404).json({ success: false, message: 'Not found' });
  await masterService.unlinkTelegram(req.params.token);
  return res.json({ success: true });
}

async function submitTopupReceipt(req, res) {
  const master = await masterService.getMasterByToken(req.params.token);
  if (!master) return res.status(404).json({ success: false, message: 'Not found' });
  if (!req.file) return res.status(400).json({ success: false, message: 'No file' });

  const key = `topup_receipt_limit:${master.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RECEIPT_RATE_WINDOW_SECONDS);
  if (count > RECEIPT_RATE_MAX) {
    return res.status(429).json({ success: false, message: 'Too many requests' });
  }

  const fileUrl = `${getBaseUrl()}/uploads/${req.file.filename}`;
  await telegramService.sendTopupReceipt(master, fileUrl, req.file.mimetype.startsWith('image/'));

  return res.json({ success: true });
}

module.exports = {
  list,
  sendOtp,
  verifyOtp,
  register,
  statusPage,
  logout,
  loginRequestCode,
  loginVerify,
  unlinkTelegram,
  sendSupportMessage,
  activatePromo,
  submitTopupReceipt,
};
