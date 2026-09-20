module.exports = async function acceptBilling(pool, id) {
  await pool.query('UPDATE masters SET master_token=COALESCE(master_token,$2) WHERE id=$1', [id, 'billing-test-' + id]);
  const master = (await pool.query('SELECT master_token FROM masters WHERE id=$1', [id])).rows[0];
  const service = require('../src/services/providerBilling.service');
  const state = await service.state(id, 'ru');
  const result = await service.accept(master.master_token, { accepted: true, language: 'ru', digest: state.digest });
  require('node:assert/strict').equal(result.status, 200);
  return result;
};
