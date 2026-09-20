const { isGeorgianPhone } = require('../config/phone');
const redis = require('../config/redis');
const smsService = require('./sms.service');
const consentLog = require('./consentLog.service');
const crypto = require('crypto');
const serviceMessage = require('../config/service-message-copy');

const OTP_TTL_SECONDS = 300;
const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_LIMIT_MAX_REQUESTS = 3;
const VERIFIED_TTL_SECONDS = 600;

function generateCode() {
  return String(crypto.randomInt(1000, 10000));
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
  if (!isGeorgianPhone(phone)) return { success: false, reason: 'invalid_phone' };
  const allowed = await checkRateLimit(phone, purpose);
  if (!allowed) {
    return { success: false, reason: 'rate_limited' };
  }

  const code = generateCode();
  const challengeId = context.consent ? crypto.randomBytes(24).toString('hex') : null;
  await redis.set(`otp:${purpose}:${phone}`, code, 'EX', OTP_TTL_SECONDS);
  await redis.del(`otp_attempts:${purpose}:${phone}`);

  let result;
  try {
    if (orderLink) {
      const ref = orderId ? ` #${orderId}` : '';
      result = await smsService.sendOrderNotification(
        phone,
        serviceMessage.sms('orderCode', { code, reference: ref, link: orderLink }),
        { log: false }
      );
    } else {
      result = await smsService.sendOtp(phone, code);
    }
  } catch (error) {
    // The gateway did not accept the message, so nobody holds this code. Drop it and give the
    // attempt back, otherwise a gateway problem would lock people out for an hour.
    console.error(`OTP SMS was not sent (${purpose}): ${error.message}`);
    await redis.del(`otp:${purpose}:${phone}`);
    await redis.decr(`otp_limit:${purpose}:${phone}`).catch(() => {});
    return { success: false, reason: 'send_failed' };
  }

  const providerMessageId = (result && result.providerMessageId) || null;

  // Метаданные отправки — чтобы шаг verify (отдельный HTTP-запрос) мог перенести
  // provider ref / orderId на строку согласия, где их уже нет. TTL как у самого кода.
  await redis.set(
    `otp_meta:${purpose}:${phone}`,
    JSON.stringify({ ref: providerMessageId, orderId, challengeId, consent: context.consent || null, draftDetails: context.draftDetails || null, sentAt: new Date().toISOString() }),
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

  return { success: true, challengeId };
}

// context:
//   { meta }         — { ip, userAgent, xForwardedFor } из requestMeta(req)
//   { language }     — req.lang, для consent_language
//   { masterId }     — id профиля, если уже известен (вход в кабинет)
//   { termsVersion, consentText } — только для регистрации на /join
//   { strict: true } — запись согласия обязательна: если БД недоступна, verify падает
//   { recordConsent: false } — вообще не писать строку согласия для этого вызова
async function verifyCode(phone, code, purpose = 'order', context = {}) {
  if (!isGeorgianPhone(phone)) return false;
  const lockKey = `otp_verify_lock:${purpose}:${phone}`;
  const lock = crypto.randomBytes(16).toString('hex');
  if (!await redis.set(lockKey, lock, 'EX', 30, 'NX')) return false;
  try {
    const key = `otp:${purpose}:${phone}`;
    const sendMeta = await readSendMeta(phone, purpose);
    const protectedFlow = purpose === 'master' || purpose === 'order';
    if (protectedFlow && (!sendMeta.consent || !context.challengeId || context.challengeId !== sendMeta.challengeId)) return false;
    const attempts = await redis.incr(`otp_attempts:${purpose}:${phone}`);
    if (attempts === 1) await redis.expire(`otp_attempts:${purpose}:${phone}`, OTP_TTL_SECONDS);
    if (attempts > 5) { await redis.del(key); return false; }
    const storedCode = await redis.get(key);

    if (!storedCode || storedCode !== String(code)) {
      return false;
    }

    // Пишем согласие ДО инвалидации кода: если БД недоступна и флоу строгий (регистрация),
    // verify падает с 500, но код ещё жив — пользователь просто повторяет подтверждение.
    let consentRecord = null;
    if (protectedFlow || context.recordConsent !== false) {
      const snapshot = sendMeta.consent;
      try {
        consentRecord = await consentLog.recordConsentVerified({
          phone,
          purpose,
          submittedCode: code,
          masterId: context.masterId || null,
          orderId: context.orderId || sendMeta.orderId || null,
          termsVersion: snapshot ? snapshot.terms_version : context.termsVersion || null,
          language: snapshot ? snapshot.language : context.language || null,
          consentText: snapshot ? snapshot.text : context.consentText || null,
          metadata: snapshot ? {
            snapshot, terms_accepted: true, privacy_accepted: true, privacy_version: snapshot.privacy_version,
            // Historical challenges may contain this flag. New signup uses explicit
            // checkboxes; never invent a scroll event for a newer acceptance.
            ...(snapshot.termsScrolled !== undefined ? { terms_scroll_confirmed: snapshot.termsScrolled, terms_scroll_confirmed_at: snapshot.termsScrolledAt } : {}),
          } : context.metadata || null,
          providerMessageId: sendMeta.ref || null,
          meta: context.meta || {},
        });
      } catch (err) {
        console.error('consentLog.recordConsentVerified failed:', err.message);
        if (protectedFlow || context.strict) throw err;
      }
    }

    await redis.del(key);
    await redis.del(`otp_meta:${purpose}:${phone}`);
    if (protectedFlow) {
      await redis.set(`consent_grant:${purpose}:${phone}:${context.challengeId}`,
        JSON.stringify({ consentLogId: consentRecord.id, orderId: sendMeta.orderId, snapshot: sendMeta.consent, draftDetails: sendMeta.draftDetails || null }), 'EX', VERIFIED_TTL_SECONDS);
    } else {
      await redis.set(`verified:${purpose}:${phone}`, '1', 'EX', VERIFIED_TTL_SECONDS);
    }
    return true;
  } finally {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lock);
  }
}

async function getConsentGrant(phone, purpose, challengeId) {
  if (!isGeorgianPhone(phone)) return null;
  if (typeof challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(challengeId)) return null;
  const raw = await redis.get(`consent_grant:${purpose}:${phone}:${challengeId}`);
  return raw ? JSON.parse(raw) : null;
}

async function clearConsentGrant(phone, purpose, challengeId) {
  await redis.del(`consent_grant:${purpose}:${phone}:${challengeId}`);
}

async function isPhoneVerified(phone, purpose = 'order') {
  if (!isGeorgianPhone(phone)) return false;
  const value = await redis.get(`verified:${purpose}:${phone}`);
  return value === '1';
}

async function clearVerified(phone, purpose = 'order') {
  await redis.del(`verified:${purpose}:${phone}`);
}

module.exports = {
  getConsentGrant,
  clearConsentGrant,
  sendCode,
  verifyCode,
  isPhoneVerified,
  clearVerified,
};
