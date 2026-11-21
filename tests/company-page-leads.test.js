// Заявка с кнопки на странице компании (docs/company-pages.md, «Заявка со страницы компании»): форма присылает
// company=<slug>, заявка запоминает компанию (orders.preferred_master_id) — только если её страница публична;
// в списке рассылки эта компания первая, отбор получателей тот же, что у всех.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (name, exports) => require.cache[require.resolve(name)] = { exports };
stub('../src/config/db', pool); stub('../src/config/redis', new (require('ioredis-mock'))());
stub('../src/services/sms.service', { sendOrderNotification: async () => ({ ok: true, providerMessageId: 'test' }) });
stub('../src/services/telegram.service', { sendLeadToMaster: async () => false, sendToChat: async () => {}, notifyModerator: async () => {}, updateMessage: async () => {} });
const orders = require('../src/services/order.service'), pages = require('../src/services/companyPage.service');

(async () => {
  const add = async (name, phone, slug) => {
    const m = (await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active,is_subscribed,public_slug) VALUES($1,$2,$3,'movers',true,true,$4) RETURNING *", [name, phone, 'tok-' + phone, slug])).rows[0];
    await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)", [m.id]);
    return m;
  };
  const first = await add('First', '+995500000801', null);
  const chosen = await add('Chosen', '+995500000802', 'chosen-co');

  // Адрес компании → исполнитель, только у публичной страницы.
  assert.equal(await pages.masterIdBySlug('chosen-co'), chosen.id);
  assert.equal(await pages.masterIdBySlug('nobody'), null);
  await pool.query('UPDATE masters SET is_banned = true WHERE id = $1', [chosen.id]);
  assert.equal(await pages.masterIdBySlug('chosen-co'), null, 'заблокированный — не выбирается');
  await pool.query('UPDATE masters SET is_banned = false WHERE id = $1', [chosen.id]);

  // Заявка запоминает компанию.
  const pending = await orders.createPendingOrder({ phone: '+995500000899', description: 'Move a sofa', districtName: '', preferredMasterId: chosen.id });
  assert.equal(pending.preferred_master_id, chosen.id);
  const plain = await orders.createPendingOrder({ phone: '+995500000898', description: 'Move a table', districtName: '' });
  assert.equal(plain.preferred_master_id, null);

  // Рассылка: те же получатели, выбранная компания первая.
  const order = (await pool.query("INSERT INTO orders(token,phone,description,status,target_categories,preferred_master_id) VALUES('pref-1','+995500000897','Move a piano','new',ARRAY['movers'],$1) RETURNING *", [chosen.id])).rows[0];
  const withChoice = await orders.getDispatchRecipients('movers', null, 50, false, '', order);
  assert.deepEqual(withChoice.map(m => m.id), [chosen.id, first.id]);
  const other = (await pool.query("INSERT INTO orders(token,phone,description,status,target_categories) VALUES('pref-2','+995500000896','Move a bed','new',ARRAY['movers']) RETURNING *")).rows[0];
  assert.deepEqual((await orders.getDispatchRecipients('movers', null, 50, false, '', other)).map(m => m.id), [first.id, chosen.id], 'без выбора — обычный порядок');
  console.log('company-page-leads: OK');
})().catch(e => { console.error(e); process.exit(1); });
