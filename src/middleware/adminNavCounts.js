const adminNav = require('../services/adminNav.service');

// Цифры на вкладках меню для страниц админки (см. adminNav.service). Только GET: страница,
// отрисованная из POST, получает цифры скриптом из шапки. Сбой подсчёта страницу не роняет.
async function adminNavCounts(req, res, next) {
  if (req.method === 'GET' && req.path !== '/nav-counts' && req.query.format !== 'json') {
    try { res.locals.navCounts = await adminNav.counts(); }
    catch (error) { console.error('Admin nav counts failed:', error.message); }
  }
  next();
}

module.exports = adminNavCounts;
