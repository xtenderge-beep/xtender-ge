// IP и User-Agent клиента для журнала согласий (sms_consent_logs).
// Сайт стоит за двумя прокси: в X-Forwarded-For приходит «клиент, прокси» (проверено по журналу 2026-11-02: все
// 1 401 запись с заголовком — ровно два адреса, а req.ip при `trust proxy = 1` равен второму, то есть прокси).
// Адрес клиента — второй справа: адреса левее мог дописать сам клиент, их не берём. Сырой заголовок кладём
// отдельно, как есть, — на случай запроса «покажите всю цепочку прокси». Ограничения частоты запросов по-прежнему
// считают по req.ip; это отдельное решение.
function clientIp(req) {
  const list = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (list.length >= 2) return list[list.length - 2];
  return list[0] || req.ip || null;
}

function requestMeta(req) {
  if (!req) return {};
  return {
    ip: clientIp(req),
    userAgent: (typeof req.get === 'function' && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || null,
    xForwardedFor: (req.headers && req.headers['x-forwarded-for']) || null,
  };
}

module.exports = { requestMeta, clientIp };
