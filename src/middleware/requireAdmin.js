const { SESSION_COOKIE, verifySessionValue } = require('../config/adminAuth');

function requireAdmin(req, res, next) {
  const session = verifySessionValue(req.cookies[SESSION_COOKIE]);
  if (!session) return res.redirect('/admin/login');
  req.adminSession = session;
  res.locals.csrfToken = session.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  if (!req.adminSession || req.body._csrf !== req.adminSession.csrfToken) {
    return res.status(403).send('Invalid CSRF token');
  }
  next();
}

module.exports = { requireAdmin, verifyCsrf };
