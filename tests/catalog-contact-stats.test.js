// Каталог: деньги и статистика по всему сценарию открытия номера (2026-09-30). Одно списание на пару
// исполнитель + телефон заказчика, тестовые телефоны не списывают, исполнитель не видит телефон
// заказчика в истории, каждое действие записано в catalog_contact_events.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
let queue=Promise.resolve();pool.withTransaction=fn=>{const run=queue.then(async()=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}});queue=run.catch(()=>{});return run;};
const stub=(name,exports)=>require.cache[require.resolve(name)]={exports};stub('../src/config/db',pool);
const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const controller=require('../src/controllers/master.controller'),masters=require('../src/services/master.service');
const catalogSession=require('../src/services/catalogSession.service'),stats=require('../src/services/catalogStats.service');
const technical=require('../src/services/technical.service'),admin=require('../src/services/admin.service');
const settings=require('../src/services/settings.service');
(async()=>{
 const provider=async(phone,balance)=>{const m=(await pool.query("INSERT INTO masters(name,phone,category,is_active,balance_tetri,contact_channels) VALUES('Stats Test',$1,'movers',true,$2,$3::jsonb) RETURNING *",[phone,balance,JSON.stringify({whatsapp:phone})])).rows[0];
  await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[m.id]);await require('./billing-fixture')(pool,m.id);return m;};
 const m=await provider('+995500000931',1000),poor=await provider('+995500000932',0);
 const price=await settings.getCatalogCallPriceTetri();
 const response=()=>({set(){},status(n){this.code=n;return this;},json(d){this.data=d;return this;},end(){this.ended=true;return this;}});
 const call=async(fn,id,cookies,body)=>{const r=response();await controller[fn]({params:{id:String(id)},cookies,body,lang:'ru'},r);return r;};
 const balance=async id=>Number((await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[id])).rows[0].balance_tetri);
 const charges=async id=>(await pool.query("SELECT * FROM balance_transactions WHERE master_id=$1 AND reason='catalog_call'",[id])).rows;
 const session=async phone=>({[catalogSession.COOKIE_NAME]:await catalogSession.create(phone)});

 // Not verified: the SMS dialog, no money.
 let r=await call('revealPhone',m.id,{},{action:'whatsapp'});
 assert.equal(r.data.needsVerification,true);assert.equal(await balance(m.id),1000);

 // Verified customer A: one charge, repeats and other buttons are free.
 const A='+995500000901',a=await session(A);
 r=await call('revealPhone',m.id,a,{action:'show'});
 assert.equal(r.data.success,true);assert.equal(r.data.alreadyOpened,false);assert.equal(r.data.phoneDisplay,'+995 500 00 09 31');
 assert.equal(await balance(m.id),1000-price);
 for(const action of ['call','whatsapp','show'])assert.equal((await call('revealPhone',m.id,a,{action})).data.alreadyOpened,true);
 assert.equal(await balance(m.id),1000-price);assert.equal((await charges(m.id)).length,1);
 // A new session a day later for the same phone: still free.
 assert.equal((await call('revealPhone',m.id,await session(A),{action:'call'})).data.alreadyOpened,true);assert.equal(await balance(m.id),1000-price);

 // Clicks after opening are counted only for a caller who opened this provider.
 assert.equal((await call('contactClick',m.id,a,{channel:'whatsapp',place:'dialog'})).code,204);
 await call('contactClick',m.id,a,{channel:'call',place:'card'});
 await call('contactClick',m.id,{},{channel:'call',place:'card'});
 await call('contactClick',poor.id,a,{channel:'call',place:'card'});
 await call('contactClick',m.id,a,{channel:'show',place:'card'});
 await call('contactClick',m.id,a,{channel:'sms',place:'card'});

 // A provider without balance: unavailable, no money.
 r=await call('revealPhone',poor.id,a,{action:'call'});
 assert.equal(r.data.reason,'unavailable');assert.equal(await balance(poor.id),0);assert.equal((await charges(poor.id)).length,0);

 // Test phone from /admin/technical: opens the number, the provider is not charged.
 const B='+995500000902';await technical.update('add_client',B,'QA');
 r=await call('revealPhone',m.id,await session(B),{action:'call'});
 assert.equal(r.data.success,true);assert.equal(await balance(m.id),1000-price);assert.equal((await charges(m.id)).length,1);
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM catalog_contact_access WHERE master_id=$1 AND caller_phone=$2',[m.id,B])).rows[0].n,1);

 // The provider's cabinet history hides the customer's phone; the admin still sees it.
 const own=(await masters.getMasterBalanceHistory(m.id)).find(h=>h.reason==='catalog_call');
 assert.equal(own.note,null);assert.doesNotMatch(JSON.stringify(await masters.getMasterBalanceHistory(m.id)),/500000901/);
 assert.match((await admin.getMasterBalanceHistory(m.id)).find(h=>h.reason==='catalog_call').note,/\+995500000901/);

 // Every step is in the statistics.
 const events=(await pool.query('SELECT event_type,channel,place,charged,technical,caller_phone FROM catalog_contact_events WHERE master_id=$1 ORDER BY id',[m.id])).rows;
 assert.deepEqual(events.map(e=>[e.event_type,e.channel,e.charged,e.technical]),[
  ['sms_gate','whatsapp',false,false],['reveal','show',true,false],['reveal','call',false,false],['reveal','whatsapp',false,false],
  ['reveal','show',false,false],['reveal','call',false,false],['contact','whatsapp',false,false],['contact','call',false,false],['reveal','call',false,true]]);
 assert.equal(events[0].caller_phone,null);assert.equal(events[1].caller_phone,A);assert.equal(events[6].place,'dialog');
 const summary=await stats.summary(m.id);
 assert.equal(summary.paid,1);assert.equal(summary.repeat,4);assert.equal(summary.technical,1);assert.equal(summary.smsGate,1);
 assert.deepEqual(summary.contacts,{whatsapp:1,call:1});assert.deepEqual(summary.openedFrom,{show:2,call:2,whatsapp:1});
 assert.equal((await stats.summary(poor.id)).unavailable,1);
 console.log('PASS: one charge per provider and customer phone, free repeats and new sessions, unavailable without money, test phones free, customer phone hidden from the provider, every step recorded');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
