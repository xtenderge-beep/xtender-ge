// /admin/sources — источники заявок: площадки со своей ссылкой (trafficSource.service.js).
const trafficSources = require('../services/trafficSource.service');
const dashboardService = require('../services/dashboard.service');
const { getBaseUrl } = require('../config/url');

const PERIODS = [['today', 'Сегодня'], ['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней']];

async function locals(req, extra = {}) {
  const period = PERIODS.some(([key]) => key === req.query.period) ? req.query.period : '30';
  const report = await trafficSources.report(dashboardService.windowFor(period));
  return {
    ...report, period, periods: PERIODS, baseUrl: getBaseUrl(),
    pages: await trafficSources.pageOptions(), langNames: trafficSources.LANG_NAMES, landingUrl: trafficSources.landingUrl,
    error: null, value: { name: '', path: '/', lang: 'ka' },
    created: req.query.created || null, removed: req.query.removed === '1', renamed: req.query.renamed === '1',
    ...extra,
  };
}

async function index(req, res) {
  res.render('admin/sources', await locals(req));
}

async function create(req, res) {
  const value = { name: String(req.body.name || ''), path: String(req.body.path || '/'), lang: trafficSources.LANGS.includes(req.body.lang) ? req.body.lang : 'ka' };
  try {
    const source = await trafficSources.create(value);
    res.redirect('/admin/sources?created=' + encodeURIComponent(source.code));
  } catch (error) {
    if (!error.status) throw error;
    res.status(error.status).render('admin/sources', await locals(req, { error: error.message, value }));
  }
}

async function rename(req, res) {
  try {
    if (!(await trafficSources.rename(req.params.id, req.body.name))) return res.status(404).send('Площадка не найдена');
    res.redirect('/admin/sources?renamed=1');
  } catch (error) {
    if (!error.status) throw error;
    res.status(error.status).render('admin/sources', await locals(req, { error: error.message }));
  }
}

async function remove(req, res) {
  await trafficSources.remove(req.params.id);
  res.redirect('/admin/sources?removed=1');
}

module.exports = { index, create, rename, remove };
