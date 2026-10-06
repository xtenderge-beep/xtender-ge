// Подсказка грузчику на заявке, где нужна и машина: кто её видит, когда она пропадает и что в ней написано.
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
const dispatch=require('../src/services/dispatch.service'),session=require('../src/services/masterSession.service'),hint=require('../src/config/vehicleHint');
const needs=require('../src/services/orderNeeds.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
const response=()=>({locals:{},cookies:{},set(){},status(){return this;},cookie(name,value){this.cookies[name]=value;},redirect(url){this.redirected=url;},render(view,data){this.view=view;this.data=data;}});
const request=(params,cookies={},query={})=>({params,cookies,query,lang:['ka','ru','en'].includes(cookies.lang) ? cookies.lang : 'ka',secure:false,headers:{}});
let seq=0;
async function provider(name,services,cityIds) {
  const phone='+99550000810'+(++seq),m=await masters.registerMaster({name,phone,serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone,services,cityIds,spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[m.id]);await require('./billing-fixture')(pool,m.id);
  const token=(await pool.query('SELECT master_token FROM masters WHERE id=$1',[m.id])).rows[0].master_token;
  const login=response();await session.start({cookies:{}},login,token);
  return {id:m.id,cookies:{master_session:login.cookies.master_session}};
}
(async()=>{
  // Правило: грузчик подходит заявке, его машина — нет, а машина нужна: стоит отметка менеджера
  // или в заявке ещё открыта перевозка.
  assert.equal(hint.needed(['movers'],['movers'],true),true,'отметка менеджера у заявки только грузчикам');
  assert.equal(hint.needed(['movers'],['movers'],true,true),false,'у исполнителя есть своя машина');
  assert.equal(hint.needed(['movers'],[],true),false,'заявке не подходит');
  assert.equal(hint.needed(['transport','movers'],['transport','movers'],true),false,'своя машина подходит заявке');
  assert.equal(hint.needed(['transport','movers'],['movers'],false,true),true,'своя машина есть, но открытой перевозке не подходит');
  assert.deepEqual([hint.flagged({requirements:{movers_need_vehicle:true}}),hint.flagged({requirements:{}}),hint.flagged({requirements:null}),hint.flagged(null)],[true,false,false,false]);
  assert.equal(hint.needed(['transport','movers'],['movers']),true);
  assert.equal(hint.needed(['flatbed','movers'],['movers']),true,'бортовая — тоже машина');
  assert.equal(hint.needed(['transport','movers'],['transport','movers']),false,'своя машина подходит заявке');
  assert.equal(hint.needed(['movers'],['movers']),false,'машина в заявке не нужна или уже найдена');
  assert.equal(hint.needed(['transport','movers'],['transport']),false,'заявку получил как перевозчик');
  assert.equal(hint.needed(['transport','movers'],[]),false,'заявке не подходит');
  assert.deepEqual([hint.available('tbilisi'),hint.available('batumi'),hint.available(undefined)],[true,false,false]);
  assert.deepEqual(['ka','ru','en'].map(hint.guideUrl),['https://delivery.yandex.com/ge-ka/cargo/tbilisi/','https://delivery.yandex.com/ge-en/cargo/tbilisi/','https://delivery.yandex.com/ge-en/cargo/tbilisi/'],'русской страницы у Яндекса нет');

  await pool.query("UPDATE cities SET is_active=true WHERE slug='batumi'");
  const city=Object.fromEntries((await pool.query('SELECT id,slug FROM cities')).rows.map(row=>[row.slug,row.id]));
  const everywhere=[city.tbilisi,city.batumi],crew={type:'movers',attributes:{crew_size:2}};
  const mover=await provider('Грузчик',[crew],everywhere);
  const withVan=await provider('Машина и грузчики',[{type:'van',attributes:{body:'closed',cargo_length_cm:400,cargo_width_cm:190,cargo_height_cm:200}},crew],everywhere);
  let n=0;
  const add=async()=>(await pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,'+995500008999','Переезд: диван, шкаф и коробки','pending_review',$3) RETURNING *",['hint-'+(++n),'hint-owner-'+n,[]])).rows[0];
  const page=async(order,cookies={},query={})=>{const res=response();await controller.show(request({token:order.token},cookies,query),res);return res;};
  const seen=async(order,who,cookies={})=>(await page(order,{...who.cookies,...cookies},{master:String(who.id)})).data.vehicleHint;

  // Машин нужного класса нет: менеджер оставил «Перевозки» отмеченными и отправил заявку грузчикам.
  const noVans=await add();
  const plan=await dispatch.planNeeds(noVans.token,{needs:['transport','movers'],transportSize:['XXL']});
  assert.deepEqual(plan.services.map(service=>[service.key,service.count]),[['transport',0],['movers',2]]);
  await dispatch.sendNeeds(noVans.token,{needs:['transport','movers'],transportSize:['XXL']},{total:2,price:plan.price,revision:plan.revision});
  assert.deepEqual((await orders.getOrderByToken(noVans.token)).target_categories,['transport','movers'],'перевозка без получателей остаётся в заявке');
  assert.deepEqual(await seen(noVans,mover),{url:'https://delivery.yandex.com/ge-ka/cargo/tbilisi/'});
  assert.deepEqual(await seen(noVans,mover,{lang:'ru'}),{url:'https://delivery.yandex.com/ge-en/cargo/tbilisi/'});
  assert.ok(await seen(noVans,withVan),'машина есть, но меньше нужного класса');
  assert.equal((await page(noVans)).data.vehicleHint,null,'открывший без входа — не исполнитель');
  assert.equal((await page(noVans,{['order_'+noVans.token]:noVans.owner_token})).data.vehicleHint,null,'заказчик подсказку не видит');
  // Заказчик нашёл машину и закрыл перевозку — грузчики ему по-прежнему нужны, подсказка уходит.
  await orders.closeOrderCategory(noVans.token,'transport');
  assert.equal((await orders.getOrderByToken(noVans.token)).status,'new');
  assert.equal(await seen(noVans,mover),null);

  // Перевозка любого размера: грузчик со своей машиной получает заявку и как перевозчик.
  const anySize=await add();
  await dispatch.sendNeeds(anySize.token,{needs:['transport','movers']});
  assert.ok(await seen(anySize,mover));
  assert.equal(await seen(anySize,withVan),null);

  // Заявка только грузчикам: без отметки менеджера подсказки нет, и ключ в потребности не пишется.
  const lifting=await add();
  await dispatch.sendNeeds(lifting.token,{needs:['movers']});
  assert.equal(await seen(lifting,mover),null);
  assert.ok(!('movers_need_vehicle' in (await orders.getOrderByToken(lifting.token)).requirements));

  // Менеджер отметил «Клиенту нужна и машина» под «Грузчики» — перевозку отмечать не обязательно.
  const marked=await add(),form={needs:['movers'],moversVehicle:'on'};
  assert.equal((await needs.draft(marked,form)).moversVehicle,true);
  assert.equal((await needs.draft(marked,{needs:['transport'],moversVehicle:'on'})).moversVehicle,false,'без услуги «Грузчики» отметка ничего не значит');
  const markedPlan=await dispatch.planNeeds(marked.token,form);
  assert.equal(markedPlan.total,2,'на получателей отметка не влияет');
  await dispatch.sendForm(marked.token,{needs:['movers'],moversVehicle:'on',expectedTotal:'2',expectedPrice:String(markedPlan.price),revision:String(markedPlan.revision)},'manager:test');
  let saved=await orders.getOrderByToken(marked.token);
  assert.deepEqual([saved.target_categories,saved.requirements.movers_need_vehicle],[['movers'],true]);
  assert.ok(await seen(marked,mover));
  assert.equal(await seen(marked,withVan),null,'своя машина есть — подсказка не нужна');
  assert.equal((await page(marked,{['order_'+marked.token]:marked.owner_token})).data.vehicleHint,null);
  // После отправки грузчикам форма отметку не меняет: её переключает отдельное действие, версия заявки не растёт.
  assert.equal(needs.storedInput(saved).moversVehicle,true);
  assert.equal((await needs.draft(saved,{needs:['movers']})).moversVehicle,true);
  await needs.apply(marked.token,{needs:['movers']});
  assert.deepEqual([(await orders.getOrderByToken(marked.token)).requirements.movers_need_vehicle,(await orders.getOrderByToken(marked.token)).revision_version],[true,saved.revision_version]);
  await needs.setMoversVehicle(marked.token,false);
  saved=await orders.getOrderByToken(marked.token);
  assert.ok(!('movers_need_vehicle' in saved.requirements) && saved.requirements.configured===true,'остальные потребности на месте');
  assert.equal(await seen(marked,mover),null);
  await needs.setMoversVehicle(marked.token,true);
  assert.ok(await seen(marked,mover));
  assert.equal((await orders.getOrderByToken(marked.token)).revision_version,saved.revision_version);
  await assert.rejects(()=>needs.setMoversVehicle(anySize.token+'-x',true),/не найдена/);
  const vanOnly=await add();
  await dispatch.sendNeeds(vanOnly.token,{needs:['transport']});
  await assert.rejects(()=>needs.setMoversVehicle(vanOnly.token,true),/Грузчики/);

  // Экран менеджера: до отправки грузчикам — галочка в форме, после — кнопка.
  const screenHtml=async token=>ejs.renderFile(path.join(__dirname,'../src/views/manager/order-dispatch.ejs'),{...await dispatch.screen(token),manager:{id:1,name:'Менеджер',is_head_moderator:true},csrf:'test',result:null,error:null,date:v=>String(v),money:v=>String(v)});
  const fresh=await add(),freshHtml=await screenHtml(fresh.token);
  assert.ok(freshHtml.includes('<input type="checkbox" name="moversVehicle" data-vehicle-box > Клиенту нужна и машина</label>'));
  assert.ok(!freshHtml.includes('/vehicle-hint"'));
  const markedHtml=await screenHtml(marked.token);
  assert.ok(!markedHtml.includes('name="moversVehicle"'));
  assert.ok(markedHtml.includes('Подсказка о машине: <b>показывается</b></span> <button type="submit" class="secondary-action card-button" formaction="/manager/orders/'+marked.token+'/vehicle-hint" name="vehicleHint" value="off">Убрать подсказку<'));
  assert.ok((await screenHtml(lifting.token)).includes('Подсказка о машине: <b>не показывается</b></span> <button type="submit" class="secondary-action card-button" formaction="/manager/orders/'+lifting.token+'/vehicle-hint" name="vehicleHint" value="on">'));
  const viaTransport=await screenHtml(anySize.token);
  assert.ok(viaTransport.includes('Подсказка о машине: <b>показывается</b> — в заявке открыты «Перевозки»</span></p>'),'открытая перевозка включает подсказку сама, кнопки нет');
  // Скрипт экрана должен разбираться: в нём правило «отмеченные „Перевозки“ ставят галочку сами».
  for(const html of [freshHtml,markedHtml]) for(const part of html.split('<script>').slice(1)) new (require('vm').Script)(part.split('</script>')[0]);
  // Город, где грузового тарифа Яндекса нет.
  const batumi=await add();
  await dispatch.sendNeeds(batumi.token,{needs:['transport','movers'],moversVehicle:'on',cityId:String(city.batumi)});
  assert.equal((await orders.getOrderByToken(batumi.token)).city_id,city.batumi);
  assert.equal(await seen(batumi,mover),null);

  // Страница: блок стоит над кнопками связи, шаги свёрнуты, ссылка ведёт на страницу Яндекса.
  const res=await page(anySize,mover.cookies,{master:String(mover.id)});
  const render=(lang,locals={})=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(lang,'/'),
    ...res.locals,...res.data,lang,t:translate(lang),clientStrings:clientStrings(lang),...locals});
  for(const lang of ['ka','ru','en']) {
    const t=translate(lang),html=await render(lang,{vehicleHint:{url:hint.guideUrl(lang)}});
    const block=html.slice(html.indexOf('id="vehicleHint"'),html.indexOf('id="callBtn"'));
    assert.ok(html.includes('id="vehicleHint"') && html.indexOf('id="vehicleHint"')<html.indexOf('id="callBtn"'),lang+': подсказка над кнопками связи');
    for(const key of ['title','lead','how','step1','step2','step3','step4','limits','link']) {
      assert.notEqual(t('vehicle_hint_'+key),'vehicle_hint_'+key,lang+': '+key+' переведён');
      assert.ok(block.includes(ejs.escapeXML(t('vehicle_hint_'+key))),lang+': '+key+' на странице');
    }
    assert.ok(block.indexOf('<details')<block.indexOf(ejs.escapeXML(t('vehicle_hint_step1'))) && !block.includes('<details open'),lang+': шаги свёрнуты');
    assert.ok(block.includes('href="'+hint.guideUrl(lang)+'" target="_blank" rel="noopener"'));
    assert.ok(!(await render(lang,{vehicleHint:null})).includes('id="vehicleHint"'));
    assert.ok(!(await render(lang,{vehicleHint:undefined})).includes('id="vehicleHint"'),lang+': страница без нового поля не падает');
  }
  assert.ok((await render('ru')).includes('id="vehicleHint"'),'контроллер и шаблон сходятся');
  console.log('PASS: vehicle hint — a mover without a vehicle sees how to get one when the manager marked the need or transport is open, in Tbilisi only');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
