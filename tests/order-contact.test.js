const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const db = require('pg-mem').newDb();
db.public.none(fs.readFileSync(require('node:path').join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
const redis = new (require('ioredis-mock'))();
require.cache[require.resolve('../src/config/redis')] = { exports: redis };
const contact = require('../src/services/orderContact.service');
const orders = require('../src/services/order.service');
const audit = require('../src/services/consentLog.service');
const session = require('../src/services/masterSession.service');
const controller = require('../src/controllers/order.controller');
const { translate, clientStrings } = require('../src/config/i18n');
const res = () => ({ statusCode: 200, headers: {}, set(k,v) { this.headers[k]=v; return this; }, status(v) {this.statusCode=v;return this;}, json(data) {this.data=data;return this;}, render(view,data){this.data=data;return this;} });
(async () => {
  const master = (await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active) VALUES('A','+995500001001','session-provider','movers',true) RETURNING *")).rows[0];
  const other = (await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active) VALUES('B','+995500001002','other-provider','movers',true) RETURNING *")).rows[0];
  const order = (await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES('contact-order','owner-secret','+995500009999','Move a piano','new',ARRAY['movers','transport']) RETURNING *")).rows[0];
  await pool.query("INSERT INTO balance_transactions(master_id,order_id,reason,amount_tetri) VALUES($1,$2,'lead_charge',-50)",[master.id,order.id]);
  assert.equal((await contact.reveal(order.token,null,'call')).status,401);
  assert.equal((await contact.reveal(order.token,'other-provider','call')).status,403);
  assert.equal((await contact.reveal(order.token,'session-provider','bad')).status,400);
  let cookie;
  await session.start({cookies:{}},{cookie:(name,value)=>{cookie={[name]:value};}},'session-provider');
  const request = channel => ({params:{token:order.token},body:{channel,masterId:other.id},cookies:cookie,headers:{},lang:'ru'});
  let response = res(); await controller.revealContact(request('call'),response);
  assert.equal(response.statusCode,200);assert.equal(response.data.url,'tel:'+order.phone);
  assert.equal(response.headers['Cache-Control'],'no-store');
  response=res();await controller.revealContact(request('whatsapp'),response);
  assert.ok(response.data.url.startsWith('https://wa.me/995500009999?text='));
  response=res();await controller.show({params:{token:order.token},cookies:{},query:{master:master.id},lang:'ru'},response);
  assert.equal(response.data.masterId,null,'query cannot impersonate a provider or expose their cabinet');
  assert.equal(response.data.masterAccount,null);
  const locals=response.data;
  const html=await ejs.renderFile(require('node:path').join(__dirname,'../src/views/order.ejs'),{
    ...locals,lang:'ru',t:translate('ru'),clientStrings:clientStrings('ru'),currentPath:'/',isRememberedProvider:false,csrfToken:'test',
  });
  assert.ok(!html.includes(order.phone));assert.ok(!html.includes('995500009999'));
  assert.ok(!html.includes('owner-secret'));assert.ok(!html.includes('session-provider'));
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  // Exercise the same open page twice: the second click must fetch again and
  // must not navigate to a previously returned number after server closure.
  const browserScript=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('async function requestContact'))[1];
  const elements=Object.fromEntries(['callBtn','whatsappBtn','msg','contactLogin'].map(id=>[id,{
    disabled:false,textContent:'',classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){},addEventListener(){},
  }]));
  let contactRequests=0;
  const browser=vm.createContext({document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[]},window:{location:{href:''}},
    fetch:async(url,options)=>{assert.ok(url.endsWith('/contact'));assert.equal(options.cache,'no-store');contactRequests++;
      return {ok:contactRequests===1,status:contactRequests===1?200:409,json:async()=>contactRequests===1?{success:true,url:'tel:'+order.phone}:{success:false,message:'Closed'}};},
  });
  vm.runInContext(browserScript,browser);
  await vm.runInContext("requestContact('call')",browser);assert.equal(browser.window.location.href,'tel:'+order.phone);
  browser.window.location.href='';await vm.runInContext("requestContact('whatsapp')",browser);
  assert.equal(contactRequests,2);assert.equal(browser.window.location.href,'');assert.equal(elements.msg.textContent,'Closed');
  assert.equal(elements.callBtn.disabled,false);
  // A successful contact response must not outlive the server's current state.
  await orders.closeOrderCategory(order.token,'movers',{actor:'client',reason:'found_provider'});
  for(const channel of ['call','whatsapp']) {
    response=res();await controller.revealContact(request(channel),response);
    assert.equal(response.statusCode,409);assert.equal(response.data.url,undefined);
  }
  const events=(await pool.query('SELECT * FROM sms_consent_logs WHERE order_id=$1',[order.id])).rows;
  assert.equal(events.filter(e=>e.event_type==='ORDER_CONTACT_RELEASED').length,2);
  assert.equal(events.filter(e=>e.event_type==='ORDER_CONTACT_DENIED'&&e.metadata.reason==='unavailable').length,2);
  assert.ok(events.filter(e=>e.event_type==='ORDER_CONTACT_RELEASED').every(e=>e.master_id===master.id));
  await orders.closeOrder(order.token,{actor:'client',reason:'not_needed'});
  assert.equal((await contact.reveal(order.token,'session-provider','call')).status,409);
  // No response containing a contact when audit persistence fails.
  await pool.query("UPDATE orders SET status='new' WHERE id=$1",[order.id]);
  await pool.query('DELETE FROM order_category_closures WHERE order_id=$1',[order.id]);
  const original=audit.recordAction;audit.recordAction=async()=>{throw Error('audit unavailable');};
  await assert.rejects(contact.reveal(order.token,'session-provider','call'),/audit unavailable/);
  audit.recordAction=original;
  await pool.query('UPDATE masters SET is_banned=true WHERE id=$1',[master.id]);
  assert.equal((await contact.reveal(order.token,'session-provider','call')).status,403);
  await session.revoke({cookies:cookie});response=res();await controller.revealContact(request('call'),response);
  assert.equal(response.statusCode,401);
  console.log('PASS: authenticated contact release, HTML privacy, category/full closure, audit, revoked sessions');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
