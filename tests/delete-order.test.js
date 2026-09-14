const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');
const db = newDb();
const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
db.public.none(schema);
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const before = db.backup(); try { return await fn(pool); } catch (e) { before.restore(); throw e; } };
const stub = (name, exports) => require.cache[require.resolve(name)] = { exports };
const redis = new (require('ioredis-mock'))();
stub('../src/config/db', pool); stub('../src/config/redis', redis);
stub('../src/services/sms.service', { sendOtp: async () => ({}), sendOrderNotification: async () => ({ ok: true }) });
const orderService = require('../src/services/order.service');

(async () => {
  const master = (await pool.query(
    "INSERT INTO masters(name,phone,category,balance_tetri) VALUES('M','+995500000001','transport',10000) RETURNING id"
  )).rows[0];
  const order = (await pool.query(
    "INSERT INTO orders(token,phone,description,status) VALUES('deltoken01','+995500000002','Test order','pending_review') RETURNING *"
  )).rows[0];

  // Pre-existing consent log entry (as if the OTP flow already ran) — must survive deletion.
  await pool.query(
    "INSERT INTO sms_consent_logs(event_type,phone_number,order_id) VALUES('ORDER_PUBLISHED',$1,$2)",
    [order.phone, order.id]
  );

  // Simulate a real dispatch: run + delivery + the resulting balance charge.
  const run = (await pool.query('INSERT INTO dispatch_runs(order_id) VALUES($1) RETURNING id', [order.id])).rows[0];
  await pool.query(
    'INSERT INTO dispatch_deliveries(run_id,order_id,master_id,status) VALUES($1,$2,$3,$4)',
    [run.id, order.id, master.id, 'accepted']
  );
  const balanceTx = (await pool.query(
    "INSERT INTO balance_transactions(master_id,order_id,amount_tetri,reason) VALUES($1,$2,-50,'lead_charge') RETURNING id",
    [master.id, order.id]
  )).rows[0];

  // A manager's client-outreach invite that happened to result in this order.
  const manager = (await pool.query(
    "INSERT INTO managers(name,phone) VALUES('Mgr','+995500000003') RETURNING id"
  )).rows[0];
  const invite = (await pool.query(
    "INSERT INTO crm_invites(kind,phone,token,request_key,manager_id,order_id) VALUES('client',$1,'invtoken01','11111111-1111-1111-1111-111111111111',$2,$3) RETURNING id",
    [order.phone, manager.id, order.id]
  )).rows[0];

  // A view/file row, to confirm ON DELETE CASCADE still does its normal job.
  await pool.query('INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,$3)', [order.id, master.id, 'view']);

  const deleted = await orderService.deleteOrder('deltoken01', { meta: { ip: '127.0.0.1' } });
  assert.equal(deleted.id, order.id, 'deleteOrder returns the deleted row');

  assert.equal((await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows.length, 0, 'order row removed');
  assert.equal((await pool.query('SELECT * FROM dispatch_runs WHERE order_id=$1', [order.id])).rows.length, 0, 'dispatch_runs removed');
  assert.equal((await pool.query('SELECT * FROM dispatch_deliveries WHERE order_id=$1', [order.id])).rows.length, 0, 'dispatch_deliveries removed');
  assert.equal((await pool.query('SELECT * FROM order_views WHERE order_id=$1', [order.id])).rows.length, 0, 'order_views cascaded');

  const btAfter = (await pool.query('SELECT * FROM balance_transactions WHERE id=$1', [balanceTx.id])).rows[0];
  assert.ok(btAfter, 'balance_transactions row survives');
  assert.equal(btAfter.order_id, null, 'balance_transactions.order_id unlinked, not deleted');
  assert.equal(btAfter.amount_tetri, -50, 'the actual charge amount is untouched');

  const inviteAfter = (await pool.query('SELECT * FROM crm_invites WHERE id=$1', [invite.id])).rows[0];
  assert.ok(inviteAfter, 'crm_invites row survives');
  assert.equal(inviteAfter.order_id, null, 'crm_invites.order_id unlinked, not deleted');

  const consentRows = (await pool.query('SELECT * FROM sms_consent_logs WHERE order_id=$1 ORDER BY id', [order.id])).rows;
  assert.equal(consentRows.length, 2, 'original consent row plus the new ORDER_DELETED audit row both present');
  assert.equal(consentRows[0].event_type, 'ORDER_PUBLISHED');
  assert.equal(consentRows[1].event_type, 'ORDER_DELETED');

  // Deleting an already-deleted (or unknown) token is a no-op, not a crash.
  const again = await orderService.deleteOrder('deltoken01', { meta: {} });
  assert.equal(again, null, 'deleting a gone order returns null instead of throwing');

  console.log('delete-order.test.js: all assertions passed');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
