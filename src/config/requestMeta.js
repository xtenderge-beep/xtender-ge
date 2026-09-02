// IP и User-Agent клиента для журнала согласий (sms_consent_logs).
// app.js уже выставляет `trust proxy = 1`, поэтому req.ip разворачивает X-Forwarded-For
// от прокси Railway. Сырой заголовок кладём отдельно, как есть — на случай запроса
// регулятора «покажите всю цепочку прокси, а не только последний хоп».
function requestMeta(req) {
  if (!req) return {};
  return {
    ip: req.ip || null,
    userAgent: (typeof req.get === 'function' && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || null,
    xForwardedFor: (req.headers && req.headers['x-forwarded-for']) || null,
  };
}

module.exports = { requestMeta };
