// Страница заявки: на каком языке её видит заказчик и кем сайт считает открывшего —
// заказчиком или исполнителем, когда в одном браузере есть и кука заявки, и вход исполнителя.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
stub('../src/services/sms.service',{sendOrderNotification:async()=>({ok:true,providerMessageId:'test'})});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{}});
const controller=require('../src/controllers/order.controller'),masters=require('../src/services/master.service'),session=require('../src/services/masterSession.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
const response=()=>({locals:{},cookies:{},set(){},status(){return this;},cookie(name,value){this.cookies[name]=value;},redirect(url){this.redirected=url;},render(view,data){this.view=view;this.data=data;}});
const request=(params,cookies={},query={})=>({params,cookies,query,lang:['ka','ru','en'].includes(cookies.lang) ? cookies.lang : 'ka',secure:false,headers:{}});
const html=res=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(res.locals.lang || 'ka','/'),
  lang:'ka',t:translate('ka'),...res.locals,...res.data});
(async()=>{
  // pg-mem отдаёт пустой массив по умолчанию строкой, поэтому target_categories задаётся явно.
  const add=async(token,sourceLang)=>(await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,source_lang,target_categories) VALUES($1,$2,'+995500007001','Перенести пианино','pending_review',$3,$4) RETURNING *",[token,token+'-owner',sourceLang,[]])).rows[0];
  const order=await add('page-1',null);
  const consent=(await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,consent_language) VALUES('CONSENT_VERIFIED','+995500007001','ru') RETURNING id")).rows[0];
  await pool.query("INSERT INTO consent_uses(consent_log_id,subject_role,subject_id) VALUES($1,'client',$2)",[consent.id,order.id]);
  const ownerPage=async(cookies={},query={},target=order)=>{const res=response();await controller.showByOwnerToken(request({ownerToken:target.owner_token},cookies,query),res);return res;};

  // Заявку оформляли на русском сайте: страница русская, что бы ни осталось в куке браузера.
  for(const cookies of [{},{lang:'ka'},{lang:'en'}]) {
    const res=await ownerPage(cookies);
    assert.equal(res.locals.lang,'ru');assert.deepEqual(res.data.clientStrings,clientStrings('ru'));assert.equal(res.data.isOwner,true);
  }
  // Флажок в шапке — явный выбор: запоминается для этой заявки и дальше главнее языка оформления.
  const shown=await ownerPage({lang:'ka'}),markup=await html(shown);
  assert.ok(markup.includes('<html lang="ru"'));
  assert.ok(markup.includes('href="/o/page-1-owner?lang=en"'));assert.ok(!markup.includes('/lang/en?next='));
  const chosen=await ownerPage({},{lang:'en'});
  assert.equal(chosen.redirected,'/o/page-1-owner');assert.equal(chosen.view,undefined);
  assert.deepEqual([chosen.cookies['olang_page-1'],chosen.cookies.lang],['en','en']);
  assert.equal((await ownerPage({'olang_page-1':'en',lang:'ka'})).locals.lang,'en');
  assert.equal((await ownerPage({},{lang:'xx'})).locals.lang,'ru','неизвестный язык в ссылке ничего не меняет');
  // Без записи о языке оформления (старые заявки): язык текста заявки, иначе язык браузера.
  assert.equal((await ownerPage({lang:'ka'},{},await add('page-2','en'))).locals.lang,'en');
  assert.equal((await ownerPage({lang:'ru'},{},await add('page-3',null))).locals.lang,'ru');
  assert.equal((await ownerPage({},{},await add('page-4',null))).locals.lang,'ka');

  // Исполнитель и заказчик в одном браузере. Кнопки связи есть только у разосланной заявки.
  await pool.query("UPDATE orders SET status='new',target_categories=$2 WHERE id=$1",[order.id,['movers']]);
  const has=async(res,text)=>(await html(res)).includes(text);
  const master=await masters.registerMaster({name:'Грузчик',phone:'+995500007002',serviceType:null});
  await masters.updateMasterProfile(master.id,{name:'Грузчик',phone:'+995500007002',services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(master.id);
  const token=(await pool.query('SELECT master_token FROM masters WHERE id=$1',[master.id])).rows[0].master_token;
  const login=response();await session.start({cookies:{}},login,token);
  const signed={master_session:login.cookies.master_session},owner={['order_'+order.token]:order.owner_token};
  const leadPage=async(cookies,query={})=>{const res=response();await controller.show(request({token:order.token},cookies,query),res);return res;};
  // Ссылка лида вошедшего исполнителя открывает страницу исполнителя, даже если браузер помнит заказчика.
  const lead=await leadPage({...owner,...signed},{master:String(master.id)});
  assert.deepEqual([lead.data.isOwner,lead.data.masterId],[false,master.id]);
  assert.ok(await has(lead,'id="callBtn"'));
  // Номер в ссылке сам ничего не даёт: без входа и с чужим номером страница остаётся страницей заказчика.
  assert.deepEqual([(await leadPage(owner,{master:String(master.id)})).data.isOwner,(await leadPage({...owner,...signed},{master:'999'})).data.isOwner],[true,true]);
  const own=await leadPage({...owner,...signed,lang:'ka'});
  assert.deepEqual([own.data.isOwner,own.data.masterId,own.locals.lang,own.data.langHref],[true,null,'ru','/order/page-1?lang=']);
  assert.ok(!await has(own,'id="callBtn"'));
  // Посторонний с номером исполнителя в ссылке: не исполнитель и не заказчик.
  const stranger=await leadPage({},{master:String(master.id)});
  assert.deepEqual([stranger.data.isOwner,stranger.data.masterId,stranger.data.langHref],[false,null,null]);
  assert.ok(await has(stranger,'href="/master?next=%2Forder%2Fpage-1"'),'вход со страницы заявки ведёт обратно на неё');
  console.log('PASS: order page — client sees the language the order was placed in, flag choice is remembered per order, a signed-in provider opening their lead link gets the provider page');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
