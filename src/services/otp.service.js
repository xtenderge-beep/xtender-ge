const redis = require('../config/redis');
const smsService = require('./sms.service');

const OTP_TTL_SECONDS = 300;
const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_LIMIT_MAX_REQUESTS = 3;
const VERIFIED_TTL_SECONDS = 600;

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function checkRateLimit(phone) {
  const key = `otp_limit:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_TTL_SECONDS);
  }
  return count <= RATE_LIMIT_MAX_REQUESTS;
}

async function sendCode(phone, orderLink) {
  const allowed = await checkRateLimit(phone);
  if (!allowed) {
    return { success: false, reason: 'rate_limited' };
  }

  const code = generateCode();
  await redis.set(`otp:${phone}`, code, 'EX', OTP_TTL_SECONDS);

  if (orderLink) {
    await smsService.sendOrderNotification(phone, `Xtender: код ${code}, заявка: ${orderLink}`);
  } else {
    await smsService.sendOtp(phone, code);
  }

  return { success: true };
}

async function verifyCode(phone, code) {
  const key = `otp:${phone}`;
  const storedCode = await redis.get(key);

  if (!storedCode || storedCode !== String(code)) {
    return false;
  }

  await redis.del(key);
  await redis.set(`verified:${phone}`, '1', 'EX', VERIFIED_TTL_SECONDS);
  return true;
}

async function isPhoneVerified(phone) {
  const value = await redis.get(`verified:${phone}`);
  return value === '1';
}

async function clearVerified(phone) {
  await redis.del(`verified:${phone}`);
}

module.exports = {
  sendCode,
  verifyCode,
  isPhoneVerified,
  clearVerified,
};
