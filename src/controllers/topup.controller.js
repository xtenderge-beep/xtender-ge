const masters = require('../services/master.service');
const topups = require('../services/topup.service');
const redis = require('../config/redis');

async function create(req, res) {
  const master = await masters.getMasterByToken(req.params.token);
  if (!master || master.is_banned) return res.sendStatus(404);
  const amount = topups.parseAmount(req.body.amount);
  if (amount === null || !/^[a-f0-9-]{36}$/i.test(req.body.requestKey || '')) return res.status(400).json({ message: res.locals.t('pay_invalid') });
  const rateKey = `topup_create:${master.id}`;
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, 3600);
  if (count > 20) return res.status(429).json({ message: res.locals.t('pay_rate') });
  const topup = await topups.create(master.id, amount, req.body.requestKey);
  res.json({ url: `/master/${master.master_token}/topups/${topup.id}` });
}
async function show(req, res) {
  const master = await masters.getMasterByToken(req.params.token);
  const id = Number(req.params.id);
  if (!master || !Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const topup = await topups.get(id, master.id);
  if (!topup) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (req.params.format === 'pdf') {
    const pdf = await require('../services/topup-pdf.service').generate(topup, ['ka','ru','en'].includes(req.query.lang) ? req.query.lang : req.lang);
    res.type('pdf').attachment(`${topup.reference}.pdf`).send(pdf);
    return;
  }
  res.render('topup', { master, topup, purpose: topups.purpose(topup) });
}
module.exports = { create, show };
