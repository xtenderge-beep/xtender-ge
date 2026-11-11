// Админка «Анкеты от бота» (/admin/outreach/drafts): счётчики, список по источнику и статусу, ключ API бота.
const drafts = require('../services/providerDraft.service');

const STATUSES = ['draft', 'opened', 'confirmed', 'active', 'rejected', 'declined', 'opted_out', 'expired', 'test'];
const LABELS = { draft: 'Черновик', opened: 'Открыл ссылку', confirmed: 'Подтвердил, на модерации', active: 'В каталоге', rejected: 'Отклонён',
  declined: 'Не интересно (сам на странице)', opted_out: 'Просил не писать (боту)', expired: 'Срок ссылки истёк', none: 'Профиль удалён', test: 'Проба бота' };

async function index(req, res) {
  const source = typeof req.query.source === 'string' ? req.query.source.slice(0, 80) : '';
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const data = await drafts.adminRows({ source, status });
  res.render('admin/outreach-drafts', { ...data, filter: { source, status }, statuses: STATUSES, labels: LABELS,
    keyInfo: await drafts.keyInfo(), newKey: null, ttlDays: drafts.TTL_DAYS, freeDays: drafts.FREE_DAYS });
}

// Новый ключ показывается один раз, прежний сразу перестаёт работать.
async function issueKey(req, res) {
  if (req.body.confirm !== 'yes') return res.redirect('/admin/outreach/drafts');
  const key = await drafts.issueKey();
  const data = await drafts.adminRows({});
  res.set('Cache-Control', 'no-store');
  res.render('admin/outreach-drafts', { ...data, filter: { source: '', status: '' }, statuses: STATUSES, labels: LABELS,
    keyInfo: await drafts.keyInfo(), newKey: key, ttlDays: drafts.TTL_DAYS, freeDays: drafts.FREE_DAYS });
}

module.exports = { index, issueKey, LABELS };
