const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const { newDb } = require('pg-mem');
process.env.NODE_ENV = 'development';
const db = newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(); const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
require.cache[require.resolve('../src/config/redis')] = { exports: new (require('ioredis-mock'))() };
const analytics = require('../src/services/dashboard.service');
const revisions = require('../src/services/orderRevision.service');
const orderService = require('../src/services/order.service');
const ejs = require('ejs');

(async () => {
  assert.equal(new Date(analytics.windowFor('today', new Date('2026-09-12T21:30:00Z')).start).toISOString(), '2026-09-12T20:00:00.000Z');
  assert.equal(analytics.percentile([], .9), null);
  assert.equal(analytics.percentile([1, 3, 8], .5), 3);
  assert.throws(() => analytics.windowFor({from:'2026-02-30',to:'2026-03-01'},new Date('2026-09-12')), /корректные даты/);
  assert.throws(() => analytics.windowFor({from:'2026-09-02',to:'2026-09-01'},new Date('2026-09-12')), /корректные даты/);
  assert.equal(new Date(analytics.windowFor({from:'2026-09-01',to:'2026-09-02'},new Date('2026-09-12')).end).toISOString(),'2026-09-02T20:00:00.000Z');
  let empty = await analytics.getDashboard('today'); assert.equal(empty.current.confirmed, 0);
  const now = new Date(); const sent = new Date(now - 3600000); const contact = new Date(now - 1800000);
  await pool.query("INSERT INTO managers (id,name,phone) VALUES (1,'Manager','+995500000001')");
  await pool.query("INSERT INTO masters (id,name,phone,category,manager_id,is_active,is_subscribed,balance_tetri) VALUES (1,'Provider','+995500000002','movers',1,true,true,1000), (2,'Low balance','+995500000003','movers',NULL,true,true,0)");
  await pool.query("INSERT INTO orders (id,token,owner_token,phone,description,status,created_at,first_dispatched_at,target_categories) VALUES (1,'order-one','owner-one','+995500000004','Test description','new',$1,$1,ARRAY['movers']), (2,'order-two','owner-two','+995500000005','Pending description','pending_review',$1,NULL,ARRAY[]::text[]), (3,'order-three','owner-three','+995500000006','Unverified description','unverified',$1,NULL,ARRAY[]::text[])", [sent]);
  await pool.query("INSERT INTO balance_transactions (master_id,order_id,amount_tetri,reason,created_at) VALUES (1,1,-50,'lead_charge',$1),(1,NULL,1000,'topup',$1),(1,NULL,1000,'topup',$1),(1,NULL,-50,'catalog_call',$1)", [sent]);
  await pool.query("INSERT INTO order_views(order_id,master_id,event_type,viewed_at) VALUES (1,1,'call',$1),(1,1,'whatsapp',$1),(1,1,'view',$2)", [contact, new Date(sent - 1000)]);
  let report = await analytics.getDashboard('7');
  assert.equal(report.current.confirmed, 2); assert.equal(report.current.contacted, 1); assert.equal(report.current.viewed, 0);
  assert.equal(report.current.median, 30); assert.equal(report.waiting, 1); assert.equal(report.eligible, 1); assert.equal(report.lowBalance, 1);
  assert.equal(report.providers.find(p => p.id === 1).contacts, 1); assert.equal(report.providers.find(p => p.id === 1).average, 30);
  assert.equal(report.managers.find(m => m.id === 1).balance, 10); assert.equal(report.managers.find(m => m.id === 1).repeated, 1);
  assert.equal(report.money.current.topup.amount, 20); assert.equal(report.money.current.catalog_call.amount, -.5);
  for (const tab of ['overview','providers','managers','finance']) {
    report.tab = tab; report.managerFilter = '';
    const html = await ejs.renderFile(path.join(__dirname,'../src/views/admin/overview.ejs'), { dashboard: report, csrfToken: 'test' });
    assert.ok(html.includes('dashboard-content')); assert.ok(!html.includes('NaN'));
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new (require('vm').Script)(script[1]);
    if (process.env.DASHBOARD_ARTIFACTS) {
      const dir=path.resolve(process.env.DASHBOARD_ARTIFACTS);fs.mkdirSync(dir,{recursive:true});
      const css=fs.readFileSync(path.resolve(__dirname,'../../../../public/css/app.css'),'utf8');
      fs.writeFileSync(path.join(dir,tab+'.html'),html.replace('<link rel="stylesheet" href="/css/app.css">','<style>'+css+'</style>'));
    }
  }
  await assert.rejects(() => revisions.requestRevision('order-two','bad'));
  assert.equal(await revisions.requestRevision('order-one','Уточните адрес'), null);
  const revised = await revisions.requestRevision('order-two','Уточните адрес и объём');
  assert.equal(revised.status,'needs_revision'); assert.equal(await orderService.recordDispatch(2,'movers',null), false);
  assert.equal(await revisions.resubmit('order-two','wrong-owner',revised.revision_version,'Corrected description','Tbilisi','en'), null);
  assert.equal(await revisions.resubmit('order-two','owner-two',0,'Corrected description','Tbilisi','en'), null);
  await assert.rejects(() => revisions.resubmit('order-two','owner-two',revised.revision_version,'bad','Tbilisi','en'));
  const updated = await revisions.resubmit('order-two','owner-two',revised.revision_version,'Corrected description','Tbilisi','en');
  assert.equal(updated.status,'pending_review'); assert.deepEqual(updated.description_translations,{});
  assert.notEqual(revisions.csrfFor(revised), revisions.csrfFor(updated));
  assert.equal(await revisions.resubmit('order-two','owner-two',revised.revision_version,'Duplicate description','Tbilisi','en'),null);
  assert.equal(await orderService.recordDispatch(2,'movers',null),true);
  assert.equal(await revisions.requestRevision('order-two','Уточните адрес ещё раз'),null);
  assert.equal(await orderService.recordDispatch(2,'movers',null),false);
  assert.equal((await pool.query("SELECT * FROM sms_consent_logs WHERE event_type IN ('ORDER_RESUBMITTED','ORDER_REVISION_REQUESTED')")).rows.length,2);
  // The entire transition rolls back if its audit record cannot be persisted.
  await pool.query("UPDATE orders SET status='pending_review',first_dispatched_at=NULL WHERE id=3");
  const original = pool.query.bind(pool); pool.query = async (sql,...args) => { if(sql.includes('INSERT INTO sms_consent_logs')) throw Error('audit unavailable'); return original(sql,...args); };
  await assert.rejects(() => revisions.requestRevision('order-three','Уточните адрес')); pool.query=original;
  assert.equal((await orderService.getOrderByToken('order-three')).status,'pending_review');
  // Exercise real Express handlers, session protection, CSRF, JSON refresh, and customer rendering.
  process.env.ADMIN_PASSWORD = 'test-only'; process.env.ADMIN_SESSION_SECRET = 'test-only-session-secret';
  const express = require('express'); const app = express();
  app.set('views',path.join(__dirname,'../src/views')); app.set('view engine','ejs');
  app.use(express.json()); app.use(express.urlencoded({extended:false})); app.use(require('cookie-parser')());
  const i18n = require('../src/config/i18n');
  app.use((req,res,next) => { req.lang=['ru','en','ka'].includes(req.query.lang) ? req.query.lang : 'ru'; res.locals.lang=req.lang;res.locals.t=i18n.translate(req.lang);res.locals.currentPath=req.path;res.locals.originalUrl=req.originalUrl;next(); });
  app.use('/admin',require('../src/routes/admin.routes'));
  const controller=require('../src/controllers/order.controller'); const asyncHandler=require('../src/middleware/asyncHandler');
  app.get('/order/:token',asyncHandler(controller.show)); app.post('/api/orders/:token/resubmit',asyncHandler(controller.resubmit));
  app.use((err,req,res,next) => { console.error(err); res.status(500).send('test failure'); });
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const auth=require('../src/config/adminAuth').createSessionValue(); const cookie='admin_session='+auth.cookieValue;
    assert.equal((await fetch(base+'/admin?format=json',{redirect:'manual'})).status,302);
    for(const tab of ['overview','providers','managers','finance']) {
      const res=await fetch(base+'/admin?tab='+tab+'&period=7&format=json',{headers:{cookie}}); assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.ok((await res.json()).html.includes('data-dashboard-time'));
    }
    assert.equal((await fetch(base+'/admin?from=bad&to=bad',{headers:{cookie}})).status,400);
    assert.equal((await fetch(base+'/admin/orders/order-three/request-revision',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({reason:'Уточните адрес'})})).status,403);
    const revisedAgain=await revisions.requestRevision('order-three','Уточните адрес');
    const attack='Move boxes </script><script>bad()</script> and furniture';
    await pool.query("UPDATE orders SET description=$1, description_translations='{}'::jsonb WHERE id=3",[attack]);
    const ownerCookie='order_order-three=owner-three';
    const ownerResponse=await fetch(base+'/order/order-three',{headers:{cookie:ownerCookie}}); assert.equal(ownerResponse.status,200); const ownerHtml=await ownerResponse.text(); assert.ok(ownerHtml.includes('revision-form'));
    const publicHtml=await (await fetch(base+'/order/order-three')).text(); assert.ok(!publicHtml.includes('id="revision-form"')); assert.ok(!publicHtml.includes('tel:'));
    for (const lang of ['ru','en','ka']) {
      const localized=await (await fetch(base+'/order/order-three?lang='+lang,{headers:{cookie:ownerCookie}})).text();
      for (const script of localized.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new (require('vm').Script)(script[1]);
      const textScript=localized.match(/window\.__reqTexts = ([^\n]+);/)[1];
      const context={};require('vm').runInNewContext('result = '+textScript,context);assert.ok(Object.values(context.result).includes(attack), JSON.stringify({textScript,result:context.result}));
    }
    const body={revisionCsrf:revisions.csrfFor(revisedAgain),version:revisedAgain.revision_version,description:'Updated request details',district:'Tbilisi'};
    assert.equal((await fetch(base+'/api/orders/order-three/resubmit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
    assert.equal((await fetch(base+'/api/orders/order-three/resubmit',{method:'POST',headers:{cookie:ownerCookie,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
    assert.equal((await fetch(base+'/api/orders/order-three/resubmit',{method:'POST',headers:{cookie:ownerCookie,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
  console.log('PASS dashboard: timezone, empty state, SQL, deduplication, time bounds, money, manager ownership, 4 EJS tabs; revisions: validation, ownership, versions, dispatch exclusion, audit rollback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
