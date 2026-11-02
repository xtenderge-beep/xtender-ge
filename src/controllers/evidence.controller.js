const evidence = require('../services/evidence');
const subjects = require('../services/evidence/subject');
const labels = require('../services/evidence/labels');
const { requestMeta } = require('../config/requestMeta');

// /admin/evidence: поиск по номеру или профилю, запрос выгрузки с целью и причиной, код из SMS, архив.
async function show(req, res) {
  const query = String(req.query.q || '').trim().slice(0, 40);
  const found = query ? await subjects.search(query) : null;
  res.render('admin/evidence', { query, found, purposes: labels.PURPOSES, exports: await evidence.recent(), error: null, pending: null });
}

async function request(req, res) {
  const result = await evidence.request({ subject: req.body.subject, purpose: req.body.purpose, reason: req.body.reason, session: req.adminSession, meta: requestMeta(req) });
  const query = String(req.body.q || '').trim().slice(0, 40);
  if (result.error) {
    return res.status(400).render('admin/evidence', { query, found: query ? await subjects.search(query) : null, purposes: labels.PURPOSES, exports: await evidence.recent(), error: result.error, pending: null });
  }
  res.render('admin/evidence', { query, found: null, purposes: labels.PURPOSES, exports: await evidence.recent(), error: null, pending: result });
}

async function download(req, res) {
  const result = await evidence.complete({ requestId: req.body.requestId, code: req.body.code, session: req.adminSession, meta: requestMeta(req) });
  if (result.error) {
    return res.status(400).render('admin/evidence', { query: '', found: null, purposes: labels.PURPOSES, exports: await evidence.recent(), error: result.error, pending: null });
  }
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.set('X-Archive-SHA256', result.sha256);
  res.set('Cache-Control', 'no-store');
  res.send(result.archive);
}

async function receipt(req, res) {
  const found = /^\d+$/.test(req.params.id) ? await evidence.receipt(Number(req.params.id)) : null;
  if (!found) return res.status(404).send('Квитанции нет');
  res.set('Content-Type', 'application/timestamp-reply');
  res.set('Content-Disposition', `attachment; filename="xtender-evidence-${found.requestId}-archive.tsr"`);
  res.send(found.data);
}

module.exports = { show, request, download, receipt };
