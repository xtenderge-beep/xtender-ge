// Экран менеджера по заявке: расчёт «кто получит» по несохранённым потребностям, отправка всем
// отмеченным услугам одной кнопкой и расширение после отправки (добавить услугу или класс кузова).
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const sms=[];
stub('../src/services/sms.service',{sendOrderNotification:async(phone,text,context)=>{if(context?.kind==='lead')sms.push(phone);return {ok:true,providerMessageId:'test'};}});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false});
const masters=require('../src/services/master.service'),orders=require('../src/services/order.service'),dispatch=require('../src/services/dispatch.service');
const needs=require('../src/services/orderNeeds.service'),matching=require('../src/services/serviceMatching.service'),categories=require('../src/services/category.service');
let seq=0;
async function provider(name,services,{vehicleSize=null,funded=true,languages=['ru']}={}) {
  const m=await masters.registerMaster({name,phone:'+99550000600'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,vehicleSize,services,cityIds:[1],spokenLanguages:languages});
  await masters.approveMaster(m.id);
  if(funded){await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[m.id]);await require('./billing-fixture')(pool,m.id);}
  return m.id;
}
const van=(attributes={})=>({type:'van',attributes:{body:'closed',...attributes}});
const dims=(l,w,h)=>({cargo_length_cm:l,cargo_width_cm:w,cargo_height_cm:h});
const balance=async id=>(await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[id])).rows[0].balance_tetri;
const charges=async(id,orderId)=>(await pool.query("SELECT COUNT(*)::int AS n FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge'",[id,orderId])).rows[0].n;
const sentGroups=async orderId=>(await pool.query('SELECT category,vehicle_size FROM order_dispatches WHERE order_id=$1 ORDER BY id',[orderId])).rows.map(r=>r.category+':'+r.vehicle_size);
const names=service=>service.recipients.map(r=>r.name);
(async()=>{
  const plumbing=(await categories.save(null,{name_ru:'Сантехники',name_ka:'სანტექნიკოსები',name_en:'Plumbers',icon:'',is_active:true,fields:[]})).slug;
  const vanM=await provider('Фургон M',[van(dims(280,170,170))],{languages:['ru','ka']});
  const vanL=await provider('Фургон L',[van({with_helpers:'on'})],{vehicleSize:'L',languages:['ka']});
  const vanXL=await provider('Грузовик XL',[van(dims(400,200,200))]);
  const vanUnknown=await provider('Без размера',[van()]);
  await provider('Без баланса',[van(dims(300,175,180))],{funded:false});
  const mover=await provider('Грузчик',[{type:'movers',attributes:{crew_size:2}}]);
  const both=await provider('Машина и грузчики',[van(dims(310,180,185)),{type:'movers',attributes:{crew_size:2}}]);
  const plumber=await provider('Сантехник',[{type:plumbing,attributes:{}}]);
  const order=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('screen-1','+995500006999','Диван, холодильник, разгрузка и сантехник','pending_review') RETURNING *")).rows[0];
  const stored=async()=>orders.getOrderByToken(order.token);

  // Пока ничего не отмечено — считать нечего.
  const empty=await dispatch.planNeeds(order.token,{});
  assert.deepEqual([empty.services.length,empty.total,empty.charge],[0,0,0]);
  assert.deepEqual(await dispatch.availability(order),{transport:5,flatbed:0,movers:2,tow:0,bucket_lift:0,junk:0,[plumbing]:1},'сколько исполнителей каждой услуги доступно в городе заявки');

  // Три услуги сразу: исполнитель, подходящий двум услугам, считается один раз.
  const input={needs:['transport','movers',plumbing],transportSize:['M']};
  const plan=await dispatch.planNeeds(order.token,input);
  const [transport,movers,plumbers]=plan.services;
  assert.deepEqual(names(transport),['Фургон M','Машина и грузчики']);
  assert.equal(transport.recipients[0].body,'M · Д280×Ш170×В170 см');
  assert.equal(transport.unfunded,1,'подходит по требованиям, но заявку не получит: нет баланса');
  assert.deepEqual(transport.sizes.map(s=>[s.code,s.count]),[['S',0],['M',2],['L',1],['XL',1],['XXL',0]]);
  assert.deepEqual([transport.anyCount,transport.unknown],[5,1]);
  assert.deepEqual(names(movers),['Грузчик','Машина и грузчики']);
  assert.deepEqual(names(plumbers),['Сантехник']);
  assert.deepEqual([plan.total,plan.charge],[4,4*plan.price]);
  assert.deepEqual(names((await dispatch.planNeeds(order.token,{needs:['transport'],needAttributes:{transport:{with_helpers:'on'}}})).services[0]),['Фургон L'],'требование услуги сужает список сразу');
  assert.deepEqual(names((await dispatch.planNeeds(order.token,{needs:['transport']},'ka')).services[0]),['Фургон M','Фургон L'],'рассылка говорящим по-грузински');
  // Отбор по языку виден: сколько подходящих он оставил без заявки.
  const georgian=await dispatch.planNeeds(order.token,{needs:['transport']},'ka'),armenian=await dispatch.planNeeds(order.token,{needs:['transport']},'hy');
  assert.deepEqual([georgian.total,georgian.services[0].otherLanguage],[2,3]);
  assert.deepEqual([armenian.total,armenian.services[0].otherLanguage,armenian.services[0].unfunded],[0,5,0]);
  assert.equal(dispatch.planView(armenian).language,'hy');
  // Расчёт ничего не сохраняет и не отправляет.
  assert.deepEqual([(await stored()).requirements?.configured,(await stored()).revision_version,sms.length],[undefined,0,0]);
  const view=dispatch.planView(plan);
  assert.ok(!JSON.stringify(view).includes('+9955'),'в браузер не уходят телефоны');
  assert.deepEqual([view.total,view.sizes,view.services[0].recipients[0]],[4,['M'],{name:'Фургон M',body:'M · Д280×Ш170×В170 см'}]);

  // Числа изменились после того, как менеджер их увидел, — ничего не отправляется.
  await assert.rejects(()=>dispatch.sendNeeds(order.token,input,{total:3,price:plan.price,revision:plan.revision}),/изменились/);
  await assert.rejects(()=>dispatch.sendNeeds(order.token,{needs:['tow']}),/Отправлять некому/);
  assert.equal(sms.length,0);assert.equal((await stored()).first_dispatched_at,null);

  // Одна кнопка: потребности сохранены, заявка ушла всем трём услугам, списание одно на исполнителя.
  const before=await balance(both);
  const sent=await dispatch.sendNeeds(order.token,input,{total:plan.total,price:plan.price,revision:plan.revision},'',{actor:'manager:test'});
  assert.deepEqual(sent.results.map(r=>[r.key,r.size,r.count,r.error]),[['transport','M',2,undefined],['movers','',1,undefined],[plumbing,'',1,undefined]]);
  assert.equal(sent.count,4);assert.equal(sms.length,4);
  assert.equal(await balance(both),before-plan.price);assert.equal(await charges(both,order.id),1);
  assert.deepEqual(await sentGroups(order.id),['transport:M','movers:',plumbing+':']);
  let saved=await stored();
  assert.deepEqual(saved.target_categories,['transport','movers',plumbing]);
  assert.deepEqual([saved.requirements.transport_sizes,saved.requirements.transport_size],[['M'],'M']);
  assert.deepEqual((await dispatch.planNeeds(order.token,needs.storedInput(saved))).total,0,'всем подходящим уже отправлено');

  // После отправки разосланное не меняется: услугу не снять, её требования не переписать, класс не убрать.
  const narrowed=await needs.draft(saved,{needs:['movers'],needAttributes:{transport:{with_helpers:'on'},movers:{crew_size:'5'}},transportSize:['S']});
  assert.deepEqual(narrowed.categories,['transport','movers',plumbing]);
  assert.deepEqual(narrowed.details.services,{transport:{},movers:{},[plumbing]:{}});
  assert.deepEqual(narrowed.sizes,['S','M'],'класс можно только добавить');
  assert.deepEqual(narrowed.locked,{categories:['transport','movers',plumbing],sizes:['M'],anySize:false});
  assert.equal(narrowed.cityId,saved.city_id,'город после отправки не меняется');

  // Расширение: добавили класс L — заявку получает только новый исполнитель, прежний по-прежнему ей подходит.
  const wider=await dispatch.planNeeds(order.token,{needs:[],transportSize:['L']});
  assert.deepEqual(wider.needs.sizes,['M','L']);
  assert.deepEqual(names(wider.services[0]),['Фургон L']);assert.equal(wider.total,1);
  await dispatch.sendNeeds(order.token,{needs:[],transportSize:['L']},{total:1,price:wider.price,revision:wider.revision});
  saved=await stored();
  assert.deepEqual([saved.requirements.transport_sizes,saved.requirements.transport_size],[['M','L'],'']);
  assert.deepEqual(await sentGroups(order.id),['transport:M','movers:',plumbing+':','transport:L']);
  const master=async id=>(await pool.query('SELECT * FROM masters WHERE id=$1',[id])).rows[0];
  // От совпадения с заявкой зависит доступ уже заплатившего исполнителя к контакту заказчика (orderContact.service).
  assert.deepEqual(await matching.openMatches(await master(vanM),saved),['transport']);
  assert.deepEqual(await matching.openMatches(await master(vanL),saved),['transport']);
  assert.deepEqual(await matching.openMatches(await master(vanXL),saved),[],'класс XL заявке пока не подходит');
  assert.equal(await charges(vanM,order.id),1);

  // Сняли ограничение по размеру: получают остальные, включая машину без размера.
  const any=await dispatch.planNeeds(order.token,{needs:[],transportAny:'on'});
  assert.deepEqual(any.needs.sizes,[]);assert.deepEqual(names(any.services[0]),['Грузовик XL','Без размера']);
  await dispatch.sendNeeds(order.token,{needs:[],transportAny:'on'},{total:2,price:any.price,revision:any.revision});
  saved=await stored();
  assert.deepEqual(saved.requirements.transport_sizes,[]);
  for(const id of [vanM,vanL,vanXL,vanUnknown]){assert.deepEqual(await matching.openMatches(await master(id),saved),['transport']);assert.equal(await charges(id,order.id),1);}
  assert.deepEqual(await matching.openMatches(await master(both),saved),['transport','movers']);
  const done=await dispatch.planNeeds(order.token,needs.storedInput(saved));
  assert.deepEqual([done.total,done.services[0].anySent,done.services[0].alreadyReceived,done.services[0].unfunded],[0,true,5,1]);
  assert.deepEqual((await needs.draft(saved,{needs:[],transportSize:['S']})).sizes,[],'снятое ограничение по размеру не возвращается');
  assert.deepEqual((await needs.draft(saved,{needs:[]})).locked.anySize,true);

  // Добавили забытую услугу после отправки: уходит только ей.
  const tow=await provider('Эвакуатор',[{type:'tow',attributes:{tow_type:'platform',max_tonnage:'3.5'}}]);
  const added=await dispatch.planNeeds(order.token,{needs:['tow']});
  assert.deepEqual(added.services.map(s=>[s.key,s.count]),[['transport',0],['movers',0],['tow',1],[plumbing,0]]);
  await dispatch.sendNeeds(order.token,{needs:['tow']},{total:1,price:added.price,revision:added.revision});
  assert.equal(await charges(tow,order.id),1);
  assert.ok((await stored()).target_categories.includes('tow'));
  assert.equal(sms.length,8);

  // Прежние формы (админка, Telegram) сохраняют один класс — он читается как список из одного.
  const legacy=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('screen-2','+995500006998','Шкаф','pending_review') RETURNING *")).rows[0];
  await needs.save(legacy.token,['transport'],'L',{},1);
  const legacySaved=await orders.getOrderByToken(legacy.token);
  assert.deepEqual([legacySaved.requirements.transport_size,legacySaved.requirements.transport_sizes],['L',['L']]);
  assert.deepEqual(matching.needSizes({transport_size:'L'}),['L']);assert.deepEqual(matching.needSizes({}),[]);
  assert.deepEqual((await dispatch.preview(legacy.token,'transport','')).recipients.map(m=>m.id),[vanL]);
  await assert.rejects(()=>dispatch.preview(legacy.token,'transport','M'),/Размер не соответствует/);

  // Данные экрана: строки услуг, отправки с именами; «бортовая» отдельной строкой не предлагается.
  const screen=await dispatch.screen(order.token);
  assert.ok(!screen.rows.some(row=>row.key==='flatbed'));
  assert.deepEqual(screen.rows.filter(row=>row.checked).map(row=>[row.key,row.locked]),[['transport',true],['movers',true],['tow',true],[plumbing,true]]);
  assert.equal(screen.runs.length,6);assert.equal(screen.names[vanM],'Фургон M');
  assert.equal(await dispatch.screen('no-such-order'),null);
  console.log('PASS: manager order screen — live plan, one-button send to several services, one charge per provider, widening keeps earlier recipients matched');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
