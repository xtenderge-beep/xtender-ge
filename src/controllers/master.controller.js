const masterService = require('../services/master.service');
const reviewService = require('../services/review.service');
const otpService = require('../services/otp.service');
const telegramService = require('../services/telegram.service');
const smsService = require('../services/sms.service');
const { toE164 } = require('../config/phone');
const { getBaseUrl } = require('../config/url');
const { clientStrings } = require('../config/i18n');

const PHONE_REGEX = /^\+?\d{9,15}$/;
// В синхроне с order.service COST_PER_NOTIFICATION_TETRI.
const LEAD_PRICE_TETRI = 30;
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

  const result = await otpService.sendCode(toE164(rawPhone), null, OTP_PURPOSE);
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

  const isValid = await otpService.verifyCode(toE164(rawPhone), code, OTP_PURPOSE);
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

  const link = `${getBaseUrl()}/master/${master.master_token}`;

  telegramService.notifyModeratorNewMaster(master).catch((err) => {
    console.error('Failed to notify moderator about new master:', err.message);
  });
  smsService.sendOrderNotification(phone, `Xtender: заявка на регистрацию принята. Ваш баланс: ${link}`).catch((err) => {
    console.error('Failed to send registration confirmation SMS:', err.message);
  });

  return res.json({ success: true, link });
}

// Личный кабинет исполнителя — /master/<master_token>. Ссылка постоянная, приходит
// в SMS после регистрации; на неё же ведёт плашка со страницы каждого лида.
async function statusPage(req, res) {
  const strings = clientStrings(req.lang);
  const master = await masterService.getMasterByToken(req.params.token);

  if (!master) {
    return res.status(404).render('master-status', {
      master: null, reviews: [], activity: null, history: [],
      leadPriceTetri: LEAD_PRICE_TETRI, clientStrings: strings,
    });
  }

  const [reviews, activity, history] = await Promise.all([
    reviewService.listApprovedForMasters([master.id]),
    masterService.getMasterActivity(master.id),
    masterService.getMasterBalanceHistory(master.id),
  ]);

  res.render('master-status', {
    master, reviews, activity, history,
    leadPriceTetri: LEAD_PRICE_TETRI, clientStrings: strings,
  });
}

module.exports = {
  list,
  sendOtp,
  verifyOtp,
  register,
  statusPage,
};
