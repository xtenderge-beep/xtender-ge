const masterService = require('../services/master.service');
const otpService = require('../services/otp.service');
const telegramService = require('../services/telegram.service');
const { toE164 } = require('../config/phone');

const PHONE_REGEX = /^\+?\d{9,15}$/;
const ALLOWED_CATEGORIES = new Set(['movers', 'transport', 'junk']);
const ALLOWED_SIZES = new Set(['L', 'XL', 'XXL']);
const OTP_PURPOSE = 'master';

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
  const vehicleType = (req.body.vehicleType || '').trim();
  const vehicleSize = req.body.vehicleSize;
  const priceText = (req.body.priceText || '').trim();
  const description = (req.body.description || '').trim();

  if (!rawPhone || !PHONE_REGEX.test(rawPhone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!name) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }
  if (!ALLOWED_CATEGORIES.has(category)) {
    return res.status(400).json({ success: false, message: 'Invalid category' });
  }
  if (vehicleSize && !ALLOWED_SIZES.has(vehicleSize)) {
    return res.status(400).json({ success: false, message: 'Invalid vehicle size' });
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
    vehicleType: category === 'transport' ? vehicleType : null,
    vehicleSize: category === 'transport' ? vehicleSize : null,
    priceText,
    description,
  });
  await otpService.clearVerified(phone, OTP_PURPOSE);

  telegramService.notifyModeratorNewMaster(master).catch((err) => {
    console.error('Failed to notify moderator about new master:', err.message);
  });

  return res.json({ success: true });
}

module.exports = {
  list,
  sendOtp,
  verifyOtp,
  register,
};
