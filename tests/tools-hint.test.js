// Подсказка о прокате инструмента: менеджер ставит «Нужен инструмент» под услугой, исполнители этой
// услуги видят на странице заявки, что инструмент можно взять в прокат.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
stub('../src/services/sms.service',{sendOrderNotification:async()=>({ok:true,providerMessageId:'test'})});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{}});
const controller=require('../src/controllers/order.controller'),masters=require('../src/services/master.service'),orders=require('../src/services/order.service');
const dispatch=require('../src/services/dispatch.service'),session=require('../src/services/masterSession.service'),hint=require('../src/config/toolsHint');
const needs=require('../src/services/orderNeeds.service'),categories=require('../src/services/category.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
const response=()=>({locals:{},cookies:{},set(){},status(){return this;},cookie(name,value){this.cookies[name]=value;},redirect(url){this.redirected=url;},render(view,data){this.view=view;this.data=data;}});
const request=(params,cookies={},query={})=>({params,cookies,query,lang:['ka','ru','en'].includes(cookies.lang) ? cookies.lang : 'ka',secure:false,headers:{}});
let seq=0;
async function provider(name,services,cityIds) {
  const phone='+99550000820'+(++seq),m=await masters.registerMaster({name,phone,serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone,services,cityIds,spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[m.id]);await require('./billing-fixture')(pool,m.id);
  const token=(await pool.query('SELECT master_token FROM masters WHERE id=$1',[m.id])).rows[0].master_token;
  const login=response();await session.start({cookies:{}},login,token);
  return {id:m.id,cookies:{master_session:login.cookies.master_session}};
}
(async()=>{
  // Отметка есть у услуг с ручной работой; там, где исполнитель сам приезжает на технике, её нет.
  assert.deepEqual(['movers','svc_abc'].map(hint.eligible),[true,true]);
  assert.deepEqual(['transport','flatbed','tow','bucket_lift','junk'].map(hint.eligible),[false,false,false,false,false]);
  assert.deepEqual([hint.marked({requirements:{tools_needed:['movers']}}),hint.marked({requirements:{}}),hint.marked({requirements:null}),hint.marked(null)],[['movers'],[],[],[]]);
  assert.equal(hint.needed({requirements:{tools_needed:['movers']}},['movers']),true);
  assert.equal(hint.needed({requirements:{tools_needed:['movers']}},['transport']),false,'заявку получил по другой услуге');
  assert.equal(hint.needed({requirements:{}},['movers']),false);
  assert.deepEqual(['tbilisi','batumi','kutaisi',undefined].map(hint.available),[true,true,false,false]);
  assert.ok(hint.catalogUrl.startsWith('https://tools4rent.ge/catalog/?utm_source=xtender.ge'));

  await pool.query("UPDATE cities SET is_active=true WHERE slug IN ('batumi','kutaisi')");
  const city=Object.fromEntries((await pool.query('SELECT id,slug FROM cities')).rows.map(row=>[row.slug,row.id]));
  const everywhere=[city.tbilisi,city.batumi,city.kutaisi];
  const plumbing=(await categories.save(null,{name_ru:'Сантехники',name_ka:'სანტექნიკოსები',name_en:'Plumbers',icon:'',is_active:true,fields:[]})).slug;
  const mover=await provider('Грузчик',[{type:'movers',attributes:{crew_size:2}}],everywhere);
  const plumber=await provider('Сантехник',[{type:plumbing,attributes:{}}],everywhere);
  const driver=await provider('Водитель',[{type:'van',attributes:{body:'closed'}}],everywhere);
  let n=0;
  const add=async()=>(await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,'+995500008998','Снять старую плитку в ванной и вынести мусор','pending_review',$3) RETURNING *",['tools-'+(++n),'tools-owner-'+n,[]])).rows[0];
  const page=async(order,cookies={},query={})=>{const res=response();await controller.show(request({token:order.token},cookies,query),res);return res;};
  const seen=async(order,who)=>(await page(order,who.cookies,{master:String(who.id)})).data.toolsHint;
  const stored=async order=>orders.getOrderByToken(order.token);

  // Менеджер отметил «Нужен инструмент» под «Грузчики»; сантехникам заявка ушла без отметки.
  const order=await add(),form={needs:['transport','movers',plumbing],toolsNeeded:['movers','transport']};
  const draft=await needs.draft(order,form);
  assert.deepEqual(draft.tools,['movers'],'под перевозкой отметки нет, даже если её прислали');
  assert.deepEqual((await needs.draft(order,{needs:[plumbing],toolsNeeded:'movers'})).tools,[],'отметка без самой услуги ничего не значит');
  const plan=await dispatch.planNeeds(order.token,form);
  assert.equal(plan.total,3,'на получателей отметка не влияет');
  await dispatch.sendForm(order.token,{...form,expectedTotal:'3',expectedPrice:String(plan.price),revision:String(plan.revision)},'manager:test');
  let saved=await stored(order);
  assert.deepEqual(saved.requirements.tools_needed,['movers']);
  assert.deepEqual(await seen(order,mover),{url:hint.catalogUrl});
  assert.equal(await seen(order,plumber),null,'у его услуги отметки нет');
  assert.equal(await seen(order,driver),null);
  assert.equal((await page(order)).data.toolsHint,null,'открывший без входа — не исполнитель');
  assert.equal((await page(order,{['order_'+order.token]:order.owner_token})).data.toolsHint,null,'заказчик подсказку не видит');

  // После отправки форма отметку не меняет; её переключает отдельное действие, версия заявки не растёт.
  assert.deepEqual(needs.storedInput(saved).toolsNeeded,['movers']);
  assert.deepEqual((await needs.draft(saved,{needs:['movers'],toolsNeeded:[plumbing]})).tools,['movers']);
  await needs.apply(order.token,needs.storedInput(saved));
  assert.equal((await stored(order)).revision_version,saved.revision_version);
  await needs.setToolsNeeded(order.token,plumbing,true);
  assert.deepEqual((await stored(order)).requirements.tools_needed,['movers',plumbing]);
  assert.ok(await seen(order,plumber));
  await needs.setToolsNeeded(order.token,'movers',false);
  await needs.setToolsNeeded(order.token,plumbing,true);
  const sentRevision=saved.revision_version;
  saved=await stored(order);
  assert.deepEqual([saved.requirements.tools_needed,saved.requirements.configured,saved.revision_version],[[plumbing],true,sentRevision],'повторная отметка не двоится, остальные потребности и версия на месте');
  assert.equal(await seen(order,mover),null);
  await needs.setToolsNeeded(order.token,plumbing,false);
  assert.ok(!('tools_needed' in (await stored(order)).requirements),'пустой список не хранится');
  await assert.rejects(()=>needs.setToolsNeeded(order.token,'transport',true),/нет отметки/);
  await assert.rejects(()=>needs.setToolsNeeded(order.token,'tow',true),/нет отметки/);
  await assert.rejects(()=>needs.setToolsNeeded(order.token,'svc_unknown',true),/нет этой услуги/);
  await assert.rejects(()=>needs.setToolsNeeded('no-such-order','movers',true),/не найдена/);
  // Подсказка о машине и подсказка об инструменте друг другу не мешают.
  await needs.setToolsNeeded(order.token,'movers',true);
  await needs.setMoversVehicle(order.token,true);
  saved=await stored(order);
  assert.deepEqual([saved.requirements.tools_needed,saved.requirements.movers_need_vehicle],[['movers'],true]);
  await needs.setMoversVehicle(order.token,false);
  assert.deepEqual((await stored(order)).requirements.tools_needed,['movers']);
  // Заказчик закрыл услугу — подсказки по ней больше нет.
  await orders.closeOrderCategory(order.token,'movers');
  assert.equal(await seen(order,mover),null);

  // Прокат работает в Тбилиси и Батуми.
  const batumi=await add(),kutaisi=await add();
  await dispatch.sendNeeds(batumi.token,{needs:['movers'],toolsNeeded:['movers'],cityId:String(city.batumi)});
  await dispatch.sendNeeds(kutaisi.token,{needs:['movers'],toolsNeeded:['movers'],cityId:String(city.kutaisi)});
  assert.ok(await seen(batumi,mover));
  assert.equal(await seen(kutaisi,mover),null);

  // Экран менеджера: до отправки услуге — галочка в форме, после — строка состояния и кнопка.
  const screenHtml=async token=>ejs.renderFile(path.join(__dirname,'../src/views/manager/order-dispatch.ejs'),{...await dispatch.screen(token),manager:{id:1,name:'Менеджер',is_head_moderator:true},csrf:'test',result:null,error:null,date:v=>String(v),money:v=>String(v)});
  const fresh=await add(),freshHtml=await screenHtml(fresh.token);
  for(const key of ['movers',plumbing]) assert.ok(freshHtml.includes('<input type="checkbox" name="toolsNeeded" value="'+key+'" > Нужен инструмент</label>'),key);
  for(const key of ['transport','tow','bucket_lift','junk']) assert.ok(!freshHtml.includes('name="toolsNeeded" value="'+key+'"'),key+': отметки нет');
  assert.ok(!freshHtml.includes('/tools-hint"'));
  const sentHtml=await screenHtml(batumi.token);
  assert.ok(sentHtml.includes('Подсказка о прокате инструмента: <b>показывается</b></span> <button type="submit" class="secondary-action card-button" formaction="/manager/orders/'+batumi.token+'/tools-hint" name="toolsHint" value="movers:off">Убрать подсказку<'));
  assert.ok(sentHtml.includes('<input type="checkbox" name="toolsNeeded" value="'+plumbing+'" > Нужен инструмент'),'ещё не отправленной услуге отметку ставит форма');
  await needs.setToolsNeeded(batumi.token,'movers',false);
  assert.ok((await screenHtml(batumi.token)).includes('Подсказка о прокате инструмента: <b>не показывается</b></span> <button type="submit" class="secondary-action card-button" formaction="/manager/orders/'+batumi.token+'/tools-hint" name="toolsHint" value="movers:on">'));

  // Страница: блок над кнопками связи, шаги свёрнуты, ссылка ведёт в каталог проката; обе подсказки могут стоять вместе.
  await needs.setToolsNeeded(batumi.token,'movers',true);
  const res=await page(batumi,mover.cookies,{master:String(mover.id)});
  const render=(lang,locals={})=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(lang,'/'),
    ...res.locals,...res.data,lang,t:translate(lang),clientStrings:clientStrings(lang),...locals});
  for(const lang of ['ka','ru','en']) {
    const t=translate(lang),html=await render(lang),block=html.slice(html.indexOf('id="toolsHint"'),html.indexOf('id="callBtn"'));
    assert.ok(html.includes('id="toolsHint"') && html.indexOf('id="toolsHint"')<html.indexOf('id="callBtn"'),lang+': подсказка над кнопками связи');
    for(const key of ['title','lead','how','step1','step2','step3','step4','limits','link']) {
      assert.notEqual(t('tools_hint_'+key),'tools_hint_'+key,lang+': '+key+' переведён');
      assert.ok(block.includes(ejs.escapeXML(t('tools_hint_'+key))),lang+': '+key+' на странице');
    }
    assert.ok(block.indexOf('<details')<block.indexOf(ejs.escapeXML(t('tools_hint_step1'))) && !block.includes('<details open'),lang+': шаги свёрнуты');
    assert.ok(block.includes('href="'+ejs.escapeXML(hint.catalogUrl)+'" target="_blank" rel="noopener"'));
    assert.ok(t('tools_hint_lead').includes('Tools4Rent') && t('tools_hint_limits').includes('Xtender'),lang+': фирма названа как пример, и сказано, что Xtender с ней не связан');
    assert.ok(!(await render(lang,{toolsHint:null})).includes('id="toolsHint"'));
    assert.ok(!(await render(lang,{toolsHint:undefined})).includes('id="toolsHint"'),lang+': страница без нового поля не падает');
    const both=await render(lang,{vehicleHint:{url:'https://example.test/'}});
    assert.ok(both.indexOf('id="vehicleHint"')>0 && both.indexOf('id="vehicleHint"')<both.indexOf('id="toolsHint"'));
  }
  console.log('PASS: tools hint — providers of a service the manager marked see where to rent a tool, in Tbilisi and Batumi');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
