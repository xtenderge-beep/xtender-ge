const technical = require('../services/technical.service');
const { requestMeta } = require('../config/requestMeta');

async function show(req, res) {
  res.render('admin/technical', { ...await technical.list(), error:null, saved:req.query.saved === '1' });
}

async function update(req, res) {
  try {
    await technical.update(req.body.action, req.body.value, req.body.note || '', requestMeta(req));
  } catch (error) {
    res.status(400).render('admin/technical', { ...await technical.list(), error:error.message, saved:false });
    return;
  }
  res.redirect('/admin/settings/technical?saved=1');
}

module.exports = { show, update };
