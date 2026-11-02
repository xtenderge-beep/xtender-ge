const leadStop = require('../services/leadStop.service');
const { requestMeta } = require('../config/requestMeta');

// Страница ссылки «Stop» из SMS о заявке. Номер показан не целиком: ссылку могут переслать.
function masked(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? '••• ' + digits.slice(-3) : '';
}

function render(res, status, { found, phone = '', done = null }) {
  res.set('Cache-Control', 'no-store');
  res.status(status).render('lead-stop', { found, phone: masked(phone), done });
}

async function show(req, res) {
  const row = await leadStop.find(req.params.code);
  render(res, row ? 200 : 404, { found: Boolean(row), phone: row?.stop_phone });
}

async function stop(req, res) {
  const notMine = req.body?.action === 'not_mine';
  const result = await leadStop.stop(req.params.code, { notMine, meta: requestMeta(req) });
  render(res, result ? 200 : 404, { found: Boolean(result), phone: result?.phone, done: result ? (notMine ? 'not_mine' : 'stop') : null });
}

module.exports = { show, stop };
