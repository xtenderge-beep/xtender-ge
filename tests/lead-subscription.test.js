// «Больше не присылать мне заявки»: исполнитель отписывается со страницы заявки (по личной ссылке из SMS или
// войдя в кабинет) и возвращается сам — там же или в кабинете. Рассылка отписавшегося пропускает, каталог —
// нет. Чужая или пересланная ссылка ничего не меняет. Каждое изменение — строка в журнале действий исполнителя.
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
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service');
const controller=require('../src/controllers/order.controller'),cabinet=require('../src/controllers/master.controller');
const subscription=require('../src/services/leadSubscription.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
let seq=0;
async function provider(name) {
  const m=await masters.registerMaster({name,phone:'+99550000830'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query("UPDATE masters SET language='ru' WHERE id=$1",[m.id]);
  return (await pool.query('SELECT * FROM masters WHERE id=$1',[m.id])).rows[0];
}
const browser=(cookies={})=>({cookies,
  response(){const jar=this.cookies;return {locals:{},statusCode:200,set(){return this;},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},
    cookie(name,value){jar[name]=value;},redirect(url){this.redirected=url;},render(view,data){this.data=data;}};},
  request(extra){return {params:{},query:{},body:{},headers:{},lang:'ru',secure:false,cookies:this.cookies,...extra};},
  async page(token,query){const res=this.response();await controller.show(this.request({params:{token},query}),res);return res;},
  async set(token,key,subscribed){const res=this.response();await controller.setLeadSubscription(this.request({params:{token},body:{subscribed,key}}),res);return res;},
});
const html=res=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo('ru','/'),
  lang:'ru',t:translate('ru'),clientStrings:clientStrings('ru'),...res.locals,...res.data});
const cabinetSet=async(token,subscribed)=>{const res=browser().response();await cabinet.setLeadSubscription({params:{token},body:{subscribed},lang:'ru',cookies:{}},res);return res;};
const subscribed=async id=>(await pool.query('SELECT is_subscribed FROM masters WHERE id=$1',[id])).rows[0].is_subscribed;
const events=async id=>(await pool.query("SELECT actor, action, body FROM master_admin_events WHERE master_id=$1 AND action LIKE 'leads_%' ORDER BY id",[id])).rows;
const newOrder=(token,description)=>pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,'+995500008999',$3,'pending_review',$4) RETURNING *",[token,token+'-owner',description,[]]).then(r=>r.rows[0]);
const t=translate('ru');
(async()=>{
  const first=await provider('Первый'),second=await provider('Второй');
  const order=await newOrder('subs-1','Перенести диван');
  assert.equal((await dispatch.sendNeeds(order.token,{needs:['movers']},null,'',{actor:'test'})).count,2);
  const keyOf=(master,token)=>sms.filter(item=>item.phone===master.phone).map(item=>item.text.match(new RegExp('/order/'+token+'\\?k=([A-Za-z0-9_-]{22})$'))?.[1]).find(Boolean);
  const key=keyOf(first,order.token);
  assert.ok(key);

  // По ссылке из SMS внизу страницы — «Больше не присылать мне заявки».
  const phone=browser(),opened=await phone.page(order.token,{k:key});
  assert.deepEqual(opened.data.leadSubscription,{subscribed:true});
  let markup=await html(opened);
  assert.ok(markup.includes('data-lead-sub-box data-endpoint="/api/orders/subs-1/lead-subscription"'));
  assert.ok(markup.includes(t('lead_sub_off_btn')));assert.ok(markup.includes('<div data-lead-sub-view="off" hidden>'));

  // Отписка по ключу из ссылки, без входа в кабинет.
  const off=await phone.set(order.token,key,false);
  assert.deepEqual([off.statusCode,off.data],[200,{success:true,subscribed:false}]);
  assert.equal(await subscribed(first.id),false);
  assert.deepEqual(await events(first.id),[{actor:'Исполнитель',action:'leads_off',body:'Отписался от заявок (страница заявки #SUBS-1)'}]);
  assert.equal((await phone.set(order.token,key,false)).data.subscribed,false);
  assert.equal((await events(first.id)).length,1,'повторное нажатие журнал не засоряет');

  // Страница после отписки: «Снова получать заявки»; заявку по-прежнему можно открыть и позвонить.
  const after=await phone.page(order.token,{k:key});
  assert.deepEqual(after.data.leadSubscription,{subscribed:false});
  markup=await html(after);
  assert.ok(markup.includes('<div data-lead-sub-view="on" hidden>'));assert.ok(markup.includes(t('lead_sub_on_btn')));assert.ok(markup.includes('id="callBtn"'));

  // Рассылка отписавшегося пропускает: следующую заявку получает только второй. Каталог его не прячет.
  const next=await newOrder('subs-2','Поднять шкаф на 5 этаж');
  assert.equal((await dispatch.sendNeeds(next.token,{needs:['movers']},null,'',{actor:'test'})).count,1);
  assert.equal(keyOf(first,next.token),undefined);assert.ok(keyOf(second,next.token));
  assert.ok((await masters.listMasters({language:'ru'})).some(m=>m.id===first.id),'в каталоге остаётся');

  // Пересланная ссылка (другой браузер), чужой ключ и запрос без ключа ничего не меняют.
  const stranger=browser();
  assert.equal((await stranger.set(order.token,key,true)).statusCode,401);
  assert.equal((await stranger.set(order.token,key,true)).data.message,clientStrings('ru').lead_sub_login);
  assert.equal((await browser().set(order.token,'',true)).statusCode,401);
  assert.equal((await browser().set(order.token,'A'.repeat(22),true)).statusCode,401);
  assert.equal(await subscribed(first.id),false);
  const secondKey=keyOf(second,order.token);
  assert.equal((await phone.set(next.token,secondKey,false)).statusCode,401,'ключ действует только для своей заявки');
  assert.equal(await subscribed(second.id),true);

  // Вернуться можно с той же страницы и из кабинета.
  const back=await phone.set(order.token,key,true);
  assert.deepEqual(back.data,{success:true,subscribed:true});
  assert.equal(await subscribed(first.id),true);
  assert.deepEqual((await cabinetSet(first.master_token,false)).data,{success:true,subscribed:false});
  assert.deepEqual((await cabinetSet(first.master_token,true)).data,{success:true,subscribed:true});
  assert.deepEqual((await events(first.id)).map(e=>e.body),[
    'Отписался от заявок (страница заявки #SUBS-1)','Снова получает заявки (страница заявки #SUBS-1)',
    'Отписался от заявок (кабинет)','Снова получает заявки (кабинет)',
  ]);
  assert.equal((await cabinetSet('no-such-token',false)).statusCode,404);

  // Статус сверху в кабинете: «Вы отписались от заявок» и кнопка возврата вместо баланса.
  const overview=master=>ejs.renderFile(path.join(__dirname,'../src/views/partials/provider-overview.ejs'),{master,t,leadPriceTetri:30});
  await cabinetSet(first.master_token,false);
  const cabinetMarkup=await overview(await masters.getMasterByToken(first.master_token));
  assert.ok(cabinetMarkup.includes('data-account-state="unsubscribed"'));assert.ok(cabinetMarkup.includes(t('provider_unsubscribed_hint')));
  assert.ok(cabinetMarkup.includes('data-lead-sub-set="on" data-endpoint="/api/master/'+first.master_token+'/lead-subscription" data-reload'));
  assert.ok(!cabinetMarkup.includes(t('provider_free_title')));
  assert.ok((await overview(await masters.getMasterByToken(second.master_token))).includes('data-account-state="ready"'));

  // Заблокированному отписка недоступна: заявок у него и так нет, статус в кабинете — блокировка.
  await pool.query('UPDATE masters SET is_banned=true WHERE id=$1',[second.id]);
  assert.equal((await cabinetSet(second.master_token,false)).statusCode,403);
  assert.equal(await subscribed(second.id),true);

  // Администратор возвращает исполнителя в рассылку по его просьбе — запись от имени администратора.
  assert.equal(await subscription.setByAdmin(first.id,true),true);
  assert.equal(await subscribed(first.id),true);
  assert.deepEqual((await events(first.id)).at(-1),{actor:'Администратор',action:'leads_on',body:'Возвращён в рассылку заявок'});
  assert.equal(await subscription.setByAdmin(999999,true),null);

  console.log('lead-subscription.test.js: OK');
  process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
