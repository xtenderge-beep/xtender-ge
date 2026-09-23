const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
// pg-mem has no row locks: serialize transactions here. Production uses FOR UPDATE.
let queue=Promise.resolve();pool.withTransaction=fn=>{const run=queue.then(async()=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}});queue=run.catch(()=>{});return run;};
const stub=(name,exports)=>require.cache[require.resolve(name)]={exports};stub('../src/config/db',pool);
const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const service=require('../src/services/master.service'),contacts=require('../src/config/catalogContacts'),audit=require('../src/services/consentLog.service');
const controller=require('../src/controllers/master.controller'),session=require('../src/services/masterSession.service');
const {translate}=require('../src/config/i18n');
(async()=>{
 const m=(await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active,balance_tetri) VALUES('Contact Test','+995500000791','contact-test','movers',true,1000) RETURNING *")).rows[0];
 await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[m.id]);
 await require('./billing-fixture')(pool,m.id);
 const channels=contacts.parse({whatsapp:'+995 500 000 792',viber:'+995500000793',telegram:'https://t.me/test_user'});
 assert.equal(channels.whatsapp,'+995500000792');assert.equal(contacts.parse({whatsapp:'javascript:alert(1)',viber:'',telegram:''}),null);
 assert.equal(contacts.parse({whatsapp:'',viber:'',telegram:'test/../../x'}),null);
 await service.saveContacts(m.master_token,channels,['ru','en']);
 const [first,repeat]=await Promise.all([service.revealPhoneForCall(m.id,50,'+995500000794'),service.revealPhoneForCall(m.id,50,'+995500000794')]);
 assert.equal(first.alreadyOpened,false);assert.equal(repeat.alreadyOpened,true);
 assert.equal(contacts.links(first).whatsapp,'https://wa.me/995500000792');assert.equal(contacts.links(first).viber,'viber://chat?number=%2B995500000793');
 assert.equal((await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[m.id])).rows[0].balance_tetri,950);
 assert.equal((await pool.query("SELECT * FROM balance_transactions WHERE reason='catalog_call'")).rows.length,1);
 await redis.flushall();await pool.query('UPDATE masters SET balance_tetri=0 WHERE id=$1',[m.id]);
 assert.equal((await service.revealPhoneForCall(m.id,50,'+995500000794')).alreadyOpened,true);
 assert.equal(await service.revealPhoneForCall(m.id,50,'+995500000795'),null);
 await pool.query('UPDATE masters SET balance_tetri=1000 WHERE id=$1',[m.id]);
 const original=audit.recordAction;audit.recordAction=async()=>{throw Error('audit unavailable');};
 await assert.rejects(service.revealPhoneForCall(m.id,50,'+995500000796'),/audit unavailable/);audit.recordAction=original;
 assert.equal((await service.contactHistory('+995500000796')).length,0);
 assert.equal((await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[m.id])).rows[0].balance_tetri,1000);
 assert.equal((await service.contactHistory('+995500000794')).length,1);
 const listed=await service.listMasters({language:'ru'});assert.deepEqual(listed[0].available_channels,['call','whatsapp','viber','telegram']);assert.deepEqual(listed[0].spoken_languages,['ru','en']);assert.equal(listed[0].contact_channels,undefined);
 let body;await controller.list({query:{},lang:'ru'},{json:b=>{body=b;}});assert.equal(body.masters[0].phone,undefined);
 const response=()=>({status(n){this.code=n;return this;},json(data){this.data=data;return this;}});
 let res=response();await controller.saveContacts({params:{token:m.master_token},cookies:{},body:{}},res);assert.equal(res.code,401);
 let cookie;await session.start({cookies:{}},{cookie:(key,value)=>{cookie={[key]:value};}},m.master_token);
 res=response();await controller.saveContacts({params:{token:m.master_token},cookies:cookie,body:{whatsapp:'',viber:'',telegram:'',spokenLanguages:['en']},lang:'en'},res);assert.equal(res.data.success,true);
 const catalogSession = require('../src/services/catalogSession.service');
 const verified = await catalogSession.create('+995500000794');
 await redis.set('catalog_reveal_limit:+995500000794', 100);
 for (let i=0;i<3;i++) {
  const response={set(){},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
  await controller.revealPhone({params:{id:String(m.id)},cookies:{[catalogSession.COOKIE_NAME]:verified},lang:'ru'},response);
  assert.equal(response.data.success,true);assert.equal(response.data.alreadyOpened,true);
 }
 const other=(await pool.query("INSERT INTO masters(name,phone,category,is_active,spoken_languages) VALUES('Russian speaker','+995500000799','movers',true,$1::jsonb) RETURNING id", [JSON.stringify(['ru'])])).rows[0];
 await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[other.id]);
 assert.equal((await service.listMasters({language:'ru'}))[0].id,other.id);
 assert.equal((await service.listMasters({language:'en'}))[0].id,m.id);
 const profile=await service.getMasterByToken(m.master_token);assert.deepEqual(profile.spoken_languages,['en']);assert.deepEqual(contacts.links(profile),{call:'tel:'+m.phone});
 for(const lang of ['ru','en','ka']){const html=await ejs.renderFile(path.join(__dirname,'../src/views/partials/provider-contacts.ejs'),{master:profile,t:translate(lang)});for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);}
 console.log('PASS: one debit, cache loss, zero balance repeat, rollback, contact validation, separate links, private API, session protection, multilingual profile');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
