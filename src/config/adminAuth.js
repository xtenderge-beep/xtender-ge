const crypto = require('crypto');

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

// --- SMS-2FA (опционально — включается наличием ADMIN_PHONE) ---
const PENDING_2FA_COOKIE = 'admin_2fa_pending';
const PENDING_2FA_TTL_MS = 10 * 60 * 1000; // 10 минут — как окно самого OTP-кода
const TRUSTED_DEVICE_COOKIE = 'admin_2fa_trusted';
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней — не спрашивать код каждый раз

function isConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET);
}

function is2faEnabled() {
  return Boolean(process.env.ADMIN_PHONE);
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

// Пароль подтверждён, ждём SMS-код — короткоживущий токен, сам по себе доступа не
// даёт. nonce используется как ключ для лимита попыток ввода кода (см. admin.controller).
function createPending2fa() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + PENDING_2FA_TTL_MS;
  const payload = `${expiresAt}.${nonce}`;
  return { cookieValue: `${payload}.${sign(payload)}`, nonce, expiresAt };
}

function verifyPending2fa(raw) {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [expiresAtStr, nonce, sig] = parts;
  const expectedSig = sign(`${expiresAtStr}.${nonce}`);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { nonce, expiresAt };
}

// «Запомнить это устройство» на 30 дней — не спрашивать SMS-код повторно. Пароль всё
// равно проверяется каждый раз, эта кука только пропускает второй фактор.
function createTrustedDevice() {
  const expiresAt = Date.now() + TRUSTED_DEVICE_TTL_MS;
  const payload = `trusted.${expiresAt}`;
  return { cookieValue: `${payload}.${sign(payload)}`, expiresAt };
}

function verifyTrustedDevice(raw) {
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'trusted') return false;
  const [marker, expiresAtStr, sig] = parts;
  const expectedSig = sign(`${marker}.${expiresAtStr}`);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = Number(expiresAtStr);
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

// Резервный вход, если ADMIN_PHONE недоступен (потерян/разряжен телефон). Без
// настроенного кода всегда false — не открываем обходной путь по умолчанию.
function verifyRecoveryCode(candidate) {
  const expected = process.env.ADMIN_2FA_RECOVERY_CODE;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  SESSION_COOKIE,
  PENDING_2FA_COOKIE,
  PENDING_2FA_TTL_MS,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_TTL_MS,
  isConfigured,
  is2faEnabled,
  createSessionValue,
  verifySessionValue,
  verifyPassword,
  createPending2fa,
  verifyPending2fa,
  createTrustedDevice,
  verifyTrustedDevice,
  verifyRecoveryCode,
};
