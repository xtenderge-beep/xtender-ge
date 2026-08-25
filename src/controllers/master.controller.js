const masterService = require('../services/master.service');

async function list(req, res) {
  const { category } = req.query;
  const masters = await masterService.listMasters({ category });
  return res.json({ success: true, masters });
}

module.exports = {
  list,
};
