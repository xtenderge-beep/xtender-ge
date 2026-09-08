const crypto = require('crypto');
const redis = require('../config/redis');

// «Запомненный» подтверждённый телефон звонящего для платного показа номера в
// каталоге. Непрозрачный токен в Redis (не сам номер) → cookie httpOnly, JS не
// читает. Ставится в двух местах: после OTP в модалке каталога (master.controller
// catalogOtpVerify) и после подтверждения телефона при подаче заявки
// (order.controller create) — второе чтобы клиент, который только что постил
// заявку, не проходил SMS повторно ради звонка мастеру.
const COOKIE_NAME = 'catalog_verified';
const TTL_SECONDS = 24 * 60 * 60;

async function create(phone) {
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set(`catalog_session:${token}`, phone, 'EX', TTL_SECONDS);
  return token;
}

async function getPhone(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  return redis.get(`catalog_session:${token}`);
}

// Создать сессию и поставить cookie на res. Тихо гасит сбой Redis — это удобство,
// а не критический путь (без сессии человек просто пройдёт SMS в модалке).
async function issue(res, phone) {
  try {
    const token = await create(phone);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: TTL_SECONDS * 1000 });
  } catch (err) {
    console.error('catalogSession.issue failed:', err.message);
  }
}

module.exports = { COOKIE_NAME, TTL_SECONDS, create, getPhone, issue };
