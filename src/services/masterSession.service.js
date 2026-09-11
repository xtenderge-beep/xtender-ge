const { randomBytes } = require('node:crypto');
const redis = require('../config/redis');
const COOKIE = 'master_session';
const TTL = 30 * 24 * 60 * 60;
const key = value => 'master_session:' + value;
const sessionId = req => /^[a-f0-9]{64}$/.test(req.cookies?.[COOKIE] || '') ? req.cookies[COOKIE] : null;

async function revoke(req) {
  const id = sessionId(req);
  if (id) await redis.del(key(id));
}
async function start(req, res, token) {
  await revoke(req);
  const id = randomBytes(32).toString('hex');
  await redis.set(key(id), token, 'EX', TTL);
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), path: '/', maxAge: TTL * 1000 });
}
async function token(req) {
  const id = sessionId(req);
  return id ? redis.get(key(id)) : null;
}
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}
async function requireSession(req, res, next) {
  noStore(res);
  if (req.params.token === await token(req)) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ success: false, message: 'Login required' });
  return res.redirect('/master');
}
module.exports = { COOKIE, start, token, revoke, noStore, requireSession };
