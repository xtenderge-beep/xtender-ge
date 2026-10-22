// PUBLIC_BASE_URL — полный адрес с протоколом (песочница API на http://127.0.0.1:3100, scripts/api-sandbox.js):
// по нему строятся ссылки и издатель OAuth, который должен совпадать с адресом, куда ходит клиент. Обычно не задан.
function getBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3000';
}

module.exports = { getBaseUrl };
