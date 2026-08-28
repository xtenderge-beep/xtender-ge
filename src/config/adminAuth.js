const crypto = require('crypto');

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

function isConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET);
}

function sign(payload) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('hex');
}

function createSessionValue() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const payload = `${expiresAt}.${csrfToken}`;
  return { cookieValue: `${payload}.${sign(payload)}`, csrfToken, expiresAt };
}

function verifySessionValue(raw) {
  if (!raw || !isConfigured()) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [expiresAtStr, csrfToken, sig] = parts;

  const expectedSig = sign(`${expiresAtStr}.${csrfToken}`);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  return { csrfToken, expiresAt };
}

function verifyPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Сравниваются хэши фиксированной длины, а не сырые строки — timingSafeEqual
  // бросает исключение при разной длине буферов, что само по себе утекло бы
  // длину пароля через разницу в поведении.
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  SESSION_COOKIE,
  isConfigured,
  createSessionValue,
  verifySessionValue,
  verifyPassword,
};
