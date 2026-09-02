const redis = require('../config/redis');
const smsService = require('./sms.service');
const consentLog = require('./consentLog.service');

const OTP_TTL_SECONDS = 300;
const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_LIMIT_MAX_REQUESTS = 3;
const VERIFIED_TTL_SECONDS = 600;

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function checkRateLimit(phone, purpose) {
  const key = `otp_limit:${purpose}:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_TTL_SECONDS);
  }
  return count <= RATE_LIMIT_MAX_REQUESTS;
}

async function readSendMeta(phone, purpose) {
  const raw = await redis.get(`otp_meta:${purpose}:${phone}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// context: { meta } — { ip, userAgent, xForwardedFor } из requestMeta(req), для журнала.
async function sendCode(phone, orderLink, purpose = 'order', orderId = null, context = {}) {
  const allowed = await checkRateLimit(phone, purpose);
  if (!allowed) {
    return { success: false, reason: 'rate_limited' };
  }

  const code = generateCode();
  await redis.set(`otp:${purpose}:${phone}`, code, 'EX', OTP_TTL_SECONDS);

  let result;
  if (orderLink) {
    const ref = orderId ? ` #${orderId}` : '';
    result = await smsService.sendOrderNotification(
      phone,
      `Xtender: code ${code}, order${ref}: ${orderLink}`,
      { log: false }
    );
  } else {
    result = await smsService.sendOtp(phone, code);
  }

  const providerMessageId = (result && result.providerMessageId) || null;

  // Метаданные отправки — чтобы шаг verify (отдельный HTTP-запрос) мог перенести
  // provider ref / orderId на строку согласия, где их уже нет. TTL как у самого кода.
  await redis.set(
    `otp_meta:${purpose}:${phone}`,
    JSON.stringify({ ref: providerMessageId, orderId, sentAt: new Date().toISOString() }),
    'EX',
    OTP_TTL_SECONDS
  );

  consentLog
    .recordOtpSent({
      phone,
      purpose,
      code,
      orderId,
      providerMessageId,
      providerResponse: result && result.providerResponse,
      meta: context.meta || {},
    })
    .catch(() => {});

  return { success: true };
}

// context:
//   { meta }         — { ip, userAgent, xForwardedFor } из requestMeta(req)
//   { language }     — req.lang, для consent_language
//   { masterId }     — id профиля, если уже известен (вход в кабинет)
//   { termsVersion, consentText } — только для регистрации на /join
//   { strict: true } — запись согласия обязательна: если БД недоступна, verify падает
//   { recordConsent: false } — вообще не писать строку согласия для этого вызова
async function verifyCode(phone, code, purpose = 'order', context = {}) {
  const key = `otp:${purpose}:${phone}`;
  const storedCode = await redis.get(key);

  if (!storedCode || storedCode !== String(code)) {
    return false;
  }

  // Пишем согласие ДО инвалидации кода: если БД недоступна и флоу строгий (регистрация),
  // verify падает с 500, но код ещё жив — пользователь просто повторяет подтверждение.
  if (context.recordConsent !== false) {
    const sendMeta = await readSendMeta(phone, purpose);
    try {
      await consentLog.recordConsentVerified({
        phone,
        purpose,
        submittedCode: code,
        masterId: context.masterId || null,
        orderId: context.orderId || sendMeta.orderId || null,
        termsVersion: context.termsVersion || null,
        language: context.language || null,
        consentText: context.consentText || null,
        providerMessageId: sendMeta.ref || null,
        meta: context.meta || {},
      });
    } catch (err) {
      console.error('consentLog.recordConsentVerified failed:', err.message);
      if (context.strict) throw err;
    }
  }

  await redis.del(key);
  await redis.del(`otp_meta:${purpose}:${phone}`);
  await redis.set(`verified:${purpose}:${phone}`, '1', 'EX', VERIFIED_TTL_SECONDS);
  return true;
}

async function isPhoneVerified(phone, purpose = 'order') {
  const value = await redis.get(`verified:${purpose}:${phone}`);
  return value === '1';
}

async function clearVerified(phone, purpose = 'order') {
  await redis.del(`verified:${purpose}:${phone}`);
}

module.exports = {
  sendCode,
  verifyCode,
  isPhoneVerified,
  clearVerified,
};
