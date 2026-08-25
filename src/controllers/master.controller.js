const masterService = require('../services/master.service');

async function list(req, res) {
  const { category } = req.query;
  const masters = await masterService.listMasters({ category });
  return res.json({ success: true, masters });
}

async function seedTest(req, res) {
  const master = await masterService.seedTestMaster();
  return res.json({ success: true, master });
}

module.exports = {
  list,
  seedTest,
};
