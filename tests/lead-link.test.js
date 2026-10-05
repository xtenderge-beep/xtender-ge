// Личная ссылка исполнителя на заявку: ключ из SMS открывает заявку и контакт без входа в кабинет,
// но только в первом браузере, где ссылкой воспользовались. Кабинет и баланс ключ не открывает.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const sms=[];
stub('../src/services/sms.service',{sendOrderNotification:async(phone,text,context)=>{if(context?.kind==='lead')sms.push({phone,text});return {ok:true,providerMessageId:'test'};}});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{}});
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service'),leadLink=require('../src/services/leadLink.service');
const controller=require('../src/controllers/order.controller'),session=require('../src/services/masterSession.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
let seq=0;
async function provider(name,language='ru') {
  const m=await masters.registerMaster({name,phone:'+99550000810'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query('UPDATE masters SET balance_tetri=5000,language=$2 WHERE id=$1',[m.id,language]);await require('./billing-fixture')(pool,m.id);
  return (await pool.query('SELECT * FROM masters WHERE id=$1',[m.id])).rows[0];
}
// Один «браузер» — свой набор кук; ответ сервера их дополняет, как настоящий браузер.
const browser=(cookies={})=>({cookies,
  response(){const jar=this.cookies;return {locals:{},statusCode:200,set(){return this;},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},
    cookie(name,value){jar[name]=value;},redirect(url){this.redirected=url;},render(view,data){this.data=data;}};},
  request(extra){return {params:{},query:{},body:{},headers:{},lang:['ka','ru','en'].includes(this.cookies.lang)?this.cookies.lang:'ka',secure:false,cookies:this.cookies,...extra};},
  async page(token,query){const res=this.response();await controller.show(this.request({params:{token},query}),res);return res;},
  async view(token,key){const res=this.response();await controller.logView(this.request({params:{token},body:{eventType:'view',key}}),res);return res;},
  async contact(token,key,channel='call'){const res=this.response();await controller.revealContact(this.request({params:{token},body:{channel,key}}),res);return res;},
});
const html=res=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(res.locals.lang || 'ka','/'),
  lang:'ka',t:translate('ka'),clientStrings:clientStrings('ka'),...res.locals,...res.data});
const linkRow=async(orderId,masterId)=>(await pool.query('SELECT * FROM lead_links WHERE order_id=$1 AND master_id=$2',[orderId,masterId])).rows[0];
const views=async(orderId,masterId)=>(await pool.query('SELECT event_type FROM order_views WHERE order_id=$1 AND master_id=$2 ORDER BY event_type',[orderId,masterId])).rows.map(r=>r.event_type);
(async()=>{
  const first=await provider('Первый'),second=await provider('Второй','en');
  const order=(await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES('lead-1','lead-owner','+995500008999','Перенести пианино','pending_review',$1) RETURNING *",[[]])).rows[0];
  const sent=await dispatch.sendNeeds(order.token,{needs:['movers']},null,'',{actor:'test'});
  assert.equal(sent.count,2);

  // В SMS уходит ссылка с личным ключом; в базе лежит только его хеш.
  const keyOf=master=>sms.find(item=>item.phone===master.phone).text.match(/\/order\/lead-1\?k=([A-Za-z0-9_-]{22})$/)?.[1];
  const key=keyOf(first),otherKey=keyOf(second);
  assert.ok(key && otherKey && key!==otherKey);assert.ok(sms.every(item=>!item.text.includes('master=')));
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM lead_links')).rows).includes(key));
  assert.deepEqual([(await linkRow(order.id,first.id)).device_hash,(await linkRow(order.id,first.id)).bound_at],[null,null]);

  // Открытие страницы — в том числе роботом предпросмотра — ссылку не привязывает.
  const phone=browser(),preview=await phone.page(order.token,{k:key});
  assert.deepEqual([preview.data.masterId,preview.data.isOwner,preview.data.masterAccount,preview.data.linkTaken],[first.id,false,null,false]);
  assert.equal(preview.locals.lang,'ru','язык кабинета исполнителя, когда в браузере нет куки языка');
  assert.equal((await linkRow(order.id,first.id)).device_hash,null);assert.deepEqual(phone.cookies,{});
  const markup=await html(preview);
  assert.ok(markup.includes('id="callBtn"'));assert.ok(!markup.includes(order.phone));assert.ok(!markup.includes(first.master_token),'ключ не открывает кабинет');
  assert.ok(!markup.includes('id="linkTaken"'));

  // Первое действие со страницы привязывает ссылку к этому браузеру и записывает просмотр.
  assert.equal((await phone.view(order.token,key)).data.success,true);
  assert.match(phone.cookies[leadLink.DEVICE_COOKIE],/^[a-f0-9]{64}$/);
  const bound=await linkRow(order.id,first.id);
  assert.ok(bound.device_hash && bound.bound_at);assert.notEqual(bound.device_hash,phone.cookies[leadLink.DEVICE_COOKIE],'в базе хеш устройства, не сама кука');
  assert.deepEqual(await views(order.id,first.id),['view']);
  const call=await phone.contact(order.token,key);
  assert.deepEqual([call.statusCode,call.data.url],[200,'tel:'+order.phone]);
  assert.ok((await phone.contact(order.token,key,'whatsapp')).data.url.startsWith('https://wa.me/995500008999'));
  assert.deepEqual(await views(order.id,first.id),['call','view','whatsapp']);
  const released=(await pool.query("SELECT metadata FROM sms_consent_logs WHERE order_id=$1 AND master_id=$2 AND event_type='ORDER_CONTACT_RELEASED' ORDER BY id",[order.id,first.id])).rows;
  assert.deepEqual(released.map(row=>row.metadata.access),['link','link'],'в журнале видно, что контакт выдан по ссылке');
  assert.equal((await phone.page(order.token,{k:key})).data.masterId,first.id,'в своём браузере ссылка работает и дальше');

  // Ту же ссылку переслали: в другом браузере текст виден, контакт — только после входа по коду.
  const stranger=browser(),forwarded=await stranger.page(order.token,{k:key});
  assert.deepEqual([forwarded.data.masterId,forwarded.data.linkTaken,forwarded.data.isOwner],[null,true,false]);
  assert.equal(forwarded.locals.lang,'ru','подсказка о входе — на языке исполнителя, чья это ссылка');
  assert.equal((await browser({lang:'en'}).page(order.token,{k:key})).locals.lang,undefined,'выбранный в браузере язык главнее');
  const forwardedMarkup=await html(forwarded);
  assert.ok(forwardedMarkup.includes('id="linkTaken"'));assert.ok(forwardedMarkup.includes(translate('ru')('contact_link_taken')));
  assert.ok(forwardedMarkup.includes('href="/master?next=%2Forder%2Flead-1" class="text-sm'),'ссылка «Войти» видна сразу и возвращает на заявку');
  const denied=await stranger.contact(order.token,key);
  assert.deepEqual([denied.statusCode,denied.data.code,denied.data.message],[401,'link_taken',clientStrings('ka').contact_link_taken]);
  assert.equal((await stranger.view(order.token,key)).statusCode,401);
  assert.equal((await linkRow(order.id,first.id)).device_hash,bound.device_hash,'привязка не меняется');
  assert.equal((await browser({[leadLink.DEVICE_COOKIE]:'f'.repeat(64)}).contact(order.token,key)).statusCode,401,'чужая кука устройства не подходит');

  // Сам исполнитель с другого устройства входит по коду — дальше его определяет вход.
  const login=browser();await session.start({cookies:{}},login.response(),first.master_token);
  assert.equal((await login.contact(order.token,key)).statusCode,200);
  assert.equal((await login.page(order.token,{k:key})).data.masterId,first.id);

  // Чужая ссылка не даёт вошедшему исполнителю действовать за другого и не привязывается к его браузеру.
  const third=await provider('Третий'),colleague=browser();await session.start({cookies:{}},colleague.response(),third.master_token);
  const asColleague=await colleague.page(order.token,{k:otherKey});
  assert.equal(asColleague.data.masterId,third.id);
  assert.deepEqual([(await colleague.contact(order.token,otherKey)).statusCode,(await colleague.contact(order.token,otherKey)).data.code],[403,'forbidden']);
  await colleague.view(order.token,otherKey);
  assert.equal((await linkRow(order.id,second.id)).device_hash,null);assert.deepEqual(await views(order.id,second.id),[]);

  // Своя свободная ссылка привязывается и при входе: пересланная копия после этого не открывается.
  const own=browser();await session.start({cookies:{}},own.response(),second.master_token);
  assert.equal((await own.view(order.token,otherKey)).data.success,true);
  assert.ok((await linkRow(order.id,second.id)).device_hash);
  assert.equal((await browser().page(order.token,{k:otherKey})).data.linkTaken,true);

  // Неверный ключ, ключ другой заявки и испорченный ключ ничего не дают.
  const elsewhere=(await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES('lead-2','lead-owner-2','+995500008998','Другая заявка','new',$1) RETURNING *",[['movers']])).rows[0];
  for(const bad of ['A'.repeat(22),key.slice(0,21),key+'x',['a','b'],undefined]) {
    const res=await browser().page(order.token,{k:bad});
    assert.deepEqual([res.data.masterId,res.data.linkTaken],[null,false]);
    assert.equal((await browser().contact(order.token,bad)).statusCode,401);
  }
  assert.equal((await browser().page(elsewhere.token,{k:key})).data.masterId,null,'ключ действует только для своей заявки');
  assert.equal((await phone.contact(elsewhere.token,key)).statusCode,401);

  // Контакт по ссылке получает только тот, с кого списано за заявку.
  const unpaidKey=await leadLink.issue(elsewhere.id,third.id),unpaid=browser();
  assert.equal((await unpaid.page(elsewhere.token,{k:unpaidKey})).data.masterId,third.id);
  assert.deepEqual([(await unpaid.contact(elsewhere.token,unpaidKey)).statusCode,(await unpaid.contact(elsewhere.token,unpaidKey)).data.code],[403,'forbidden']);

  // В браузере заказчика своя ссылка исполнителя открывает страницу исполнителя; чужая привязанная — нет.
  const fresh=await leadLink.issue(order.id,third.id),clientBrowser=browser({['order_'+order.token]:order.owner_token});
  assert.deepEqual([(await clientBrowser.page(order.token,{k:fresh})).data.isOwner,(await clientBrowser.page(order.token,{k:key})).data.isOwner],[false,true]);

  // Новая отправка тому же исполнителю заменяет ключ и снимает привязку: старая ссылка больше не работает.
  const again=await leadLink.issue(order.id,first.id);
  assert.notEqual(again,key);assert.equal((await linkRow(order.id,first.id)).device_hash,null);
  assert.equal((await phone.contact(order.token,key)).statusCode,401);
  assert.equal((await phone.contact(order.token,again)).statusCode,200);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM lead_links WHERE order_id=$1 AND master_id=$2',[order.id,first.id])).rows[0].n,1);

  // Удаление заявки убирает её ссылки.
  await require('../src/services/order.service').deleteOrder(elsewhere.token);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM lead_links WHERE order_id=$1',[elsewhere.id])).rows[0].n,0);
  console.log('PASS: lead link — personal key in the SMS, bound to the first browser that uses it, no contact for a forwarded copy, no cabinet or balance by key');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
