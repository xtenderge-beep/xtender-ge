// Размер кузова перевозки: менеджер вводит три размера, букву S…XXL ставит система.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
stub('../src/services/sms.service',{sendOrderNotification:async()=>({ok:true,providerMessageId:'test'})});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false});
const config=require('../src/config/serviceTypes');
const masters=require('../src/services/master.service'),settings=require('../src/services/settings.service'),dispatch=require('../src/services/dispatch.service');
const body=(l,w,h)=>({body:'closed',cargo_length_cm:l,cargo_width_cm:w,cargo_height_cm:h});
let seq=0;
const register=async()=>masters.registerMaster({name:'Кузов '+(++seq),phone:'+99550000700'+seq,serviceType:null});
const save=(m,attributes,vehicleSize)=>masters.updateMasterProfile(m.id,{name:m.name,phone:m.phone,vehicleSize,services:[{type:'van',attributes}]});
const van=async id=>(await pool.query("SELECT attributes FROM master_services WHERE master_id=$1 AND service_type='van'",[id])).rows[0].attributes;
const legacy=async id=>(await pool.query('SELECT vehicle_size FROM masters WHERE id=$1',[id])).rows[0].vehicle_size;
const ready=async m=>{await masters.approveMaster(m.id);await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[m.id]);await require('./billing-fixture')(pool,m.id);};
(async()=>{
  // Машина из объявления: длина 280, ширина 170, высота 170 — до L не хватает всех трёх размеров.
  assert.equal(config.deriveVanSize(280,170,170),'M');
  assert.equal(config.deriveVanSize(450,170,200),'M','ширина 170 не пускает в L при любой длине');
  assert.equal(config.vanBody({}),null);
  assert.equal(config.vanBody({cargo_length_cm:'',cargo_width_cm:'',cargo_height_cm:''}),null);
  assert.equal(config.vanBody({cargo_length_cm:'280'}),false);
  assert.equal(config.vanBody({cargo_length_cm:'280',cargo_width_cm:'170',cargo_height_cm:'2001'}),false);
  assert.equal(config.vanBody({cargo_length_cm:'280',cargo_width_cm:'170.5',cargo_height_cm:'170'}),false);
  assert.equal(config.vanBodyLabel({size:'L'}),'L · размеры не записаны');
  assert.equal(config.vanBodyLabel({}),'размер неизвестен');

  // Размеры введены: букву ставит система, выбранная вручную не действует, размеры сохраняются.
  const measured=await register();
  await save(measured,body('280','170','170'),'XL');
  assert.deepEqual(await van(measured.id),{size:'M',cargo_length_cm:280,cargo_width_cm:170,cargo_height_cm:170,body:'closed',tail_lift:false,with_helpers:false});
  assert.equal(await legacy(measured.id),'M');
  assert.equal(config.vanBodyLabel(await van(measured.id)),'M · Д280×Ш170×В170 см');
  await assert.rejects(()=>save(measured,{body:'closed',cargo_length_cm:'280'},'M'),{code:'INVALID_SERVICE'});
  await assert.rejects(()=>save(measured,body('280','170','0'),'M'),{code:'INVALID_SERVICE'});
  assert.equal((await van(measured.id)).size,'M','отклонённое сохранение ничего не меняет');

  // Размеров нет: действует буква на глаз; без буквы размер неизвестен.
  const estimated=await register();
  await save(estimated,{body:'closed'},'L');
  assert.deepEqual(await van(estimated.id),{size:'L',body:'closed',tail_lift:false,with_helpers:false});
  const unknown=await register();
  await save(unknown,{body:'closed',cargo_length_cm:'',cargo_width_cm:'',cargo_height_cm:''},null);
  assert.equal((await van(unknown.id)).size,undefined);
  assert.equal(await legacy(unknown.id),null);
  // Размеры стёрли и букву не выбрали — прежняя буква не остаётся.
  const cleared=await register();
  await save(cleared,body('520','210','210'),null);
  assert.equal((await van(cleared.id)).size,'XXL');
  await save(cleared,{body:'closed'},null);
  assert.deepEqual(await van(cleared.id),{body:'closed',tail_lift:false,with_helpers:false});
  assert.equal(await legacy(cleared.id),null);

  // Форма потребностей заявки: расшифровка классов и число исполнителей, которым заявку можно отправить.
  for(const m of [measured,estimated,unknown]) await ready(m);
  const order=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('van-size','+995500007999','Диван и холодильник','pending_review') RETURNING *")).rows[0];
  const choices=await dispatch.transportSizes(order);
  assert.equal(choices.total,3);assert.equal(choices.unknown,1);
  assert.deepEqual(choices.sizes.map(s=>[s.code,s.count]),[['S',0],['M',1],['L',1],['XL',0],['XXL',0]]);
  assert.equal(choices.sizes[1].spec,'Д260×Ш130×В150 см');
  // Заявку с буквой получают только машины этого класса; в списке получателей виден кузов.
  const plan=await dispatch.preview(order.token,'transport','M');
  assert.deepEqual(plan.recipients.map(m=>[m.id,m.van_body]),[[measured.id,'M · Д280×Ш170×В170 см']]);
  assert.deepEqual((await dispatch.preview(order.token,'transport','')).recipients.map(m=>m.van_body).sort(),['L · размеры не записаны','M · Д280×Ш170×В170 см','размер неизвестен']);

  // Кабинет менеджера: пустой выбор класса значит «размер неизвестен», отсутствие поля оставляет букву.
  const portal=require('../src/services/managerPortal.service');
  const manager=(await pool.query("INSERT INTO managers(name,phone,is_moderator) VALUES('Менеджер кузовов','+995500007555',true) RETURNING id")).rows[0].id;
  const managed=await register();
  await portal.assignCategory(manager,managed.id,'van',{},'L',[{type:'van',attributes:{body:'closed'}}]);
  assert.equal(await legacy(managed.id),'L');
  await portal.assignCategory(manager,managed.id,'van',{},undefined,[{type:'van',attributes:{body:'closed'}}]);
  assert.equal(await legacy(managed.id),'L');
  await portal.assignCategory(manager,managed.id,'van',{},'',[{type:'van',attributes:{body:'closed'}}]);
  assert.equal(await legacy(managed.id),null);
  await portal.assignCategory(manager,managed.id,'van',{},'',[{type:'van',attributes:body('400','190','200')}]);
  assert.equal(await legacy(managed.id),'XL');
  assert.equal((await portal.detail(manager,managed.id)).master.van_body,'XL · Д400×Ш190×В200 см');

  // Несколько машин у одного исполнителя: у каждой свои класс, кузов и гидроборт, «с грузчиками» общее.
  const fleet=await register();
  await save(fleet,{...body('180','120','110'),with_helpers:'on',more_vehicles:[body('280','170','170'),{body:'flatbed',tail_lift:'on',size:'XL'}]},null);
  const fleetVan=await van(fleet.id);
  assert.equal(fleetVan.size,'S');assert.equal(await legacy(fleet.id),'S');
  assert.deepEqual(fleetVan.more_vehicles,[{size:'M',cargo_length_cm:280,cargo_width_cm:170,cargo_height_cm:170,body:'closed',tail_lift:false},{size:'XL',body:'flatbed',tail_lift:true}]);
  assert.deepEqual(config.vanVehicles(fleetVan).map(v=>[v.size,v.body,v.tail_lift,v.with_helpers]),[['S','closed',false,true],['M','closed',false,true],['XL','flatbed',true,true]]);
  assert.equal(config.vanBodyLabel(fleetVan),'S · Д180×Ш120×В110 см; M · Д280×Ш170×В170 см; XL · размеры не записаны · борт');
  const vanCategory=await require('../src/services/category.service').get('van');
  assert.deepEqual(require('../src/services/category.service').badges(vanCategory,fleetVan,'ru'),['S · M · XL','Закрытый','Борт (открытый)','Гидроборт (подъёмник)','Приезжаю с грузчиками']);
  assert.deepEqual(require('../src/services/category.service').badges(vanCategory,await van(estimated.id),'ru'),['L','Закрытый'],'одна машина — бейджи как раньше');
  // Те же машины полями формы: van_more_<номер>_<поле>, номера с пропусками, пустой блок — не машина.
  const fromForm=await register();
  await save(fromForm,{body:'closed',cargo_length_cm:'',cargo_width_cm:'',cargo_height_cm:'',more_2_body:'flatbed',more_2_size:'L',
    more_5_cargo_length_cm:'520',more_5_cargo_width_cm:'210',more_5_cargo_height_cm:'210',more_5_body:'closed',more_5_tail_lift:'on',more_5_size:'S',
    more_7_cargo_length_cm:'',more_7_cargo_width_cm:'',more_7_cargo_height_cm:'',more_7_body:'',more_7_size:''},'M');
  assert.deepEqual(await van(fromForm.id),{size:'M',body:'closed',tail_lift:false,with_helpers:false,
    more_vehicles:[{size:'L',body:'flatbed',tail_lift:false},{size:'XXL',cargo_length_cm:520,cargo_width_cm:210,cargo_height_cm:210,body:'closed',tail_lift:true}]});
  // Убрали дополнительные машины — список исчезает.
  await save(fromForm,{body:'closed'},'M');
  assert.equal((await van(fromForm.id)).more_vehicles,undefined);
  // Машина без типа кузова, с неполными размерами и одиннадцатая машина не сохраняются.
  await assert.rejects(()=>save(fromForm,{body:'closed',more_vehicles:[{size:'L'}]},'M'),{code:'INVALID_SERVICE'});
  await assert.rejects(()=>save(fromForm,{body:'closed',more_1_body:'closed',more_1_cargo_length_cm:'300'},'M'),{code:'INVALID_SERVICE'});
  await assert.rejects(()=>save(fromForm,{body:'closed',more_vehicles:Array(config.MAX_VAN_VEHICLES).fill({body:'closed',size:'S'})},'M'),{code:'INVALID_SERVICE'});
  await save(fromForm,{body:'closed',more_vehicles:Array(config.MAX_VAN_VEHICLES-1).fill({body:'closed',size:'S'})},'M');
  assert.equal(config.vanVehicles(await van(fromForm.id)).length,config.MAX_VAN_VEHICLES);
  await save(fromForm,{body:'closed'},'M');

  // Подбор: заявку получает тот, у кого подходит хотя бы одна машина, причём одна машина — целиком.
  await ready(fleet);
  const fleetOrder=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('van-fleet','+995500007998','Шкаф и коробки','pending_review') RETURNING *")).rows[0];
  const forFleet=async(category,size)=>(await dispatch.preview(fleetOrder.token,category,size)).recipients.find(m=>m.id===fleet.id);
  assert.equal((await forFleet('transport','M')).van_body,'M · Д280×Ш170×В170 см (всего машин: 3)');
  assert.equal(await forFleet('transport','L'),undefined,'класса L у него нет');
  assert.equal((await forFleet('flatbed','')).van_body,'XL · размеры не записаны · борт (всего машин: 3)');
  assert.equal((await forFleet('transport','')).van_body,'S · Д180×Ш120×В110 см; M · Д280×Ш170×В170 см; XL · размеры не записаны · борт');
  const matching=require('../src/services/serviceMatching.service'),liftRule=[{key:'tail_lift',input:'bool',match:'flag',options:[]}];
  const fleetServices=[{service_type:'van',attributes:fleetVan}];
  assert.equal(matching.matches(fleetServices,'transport','M',['transport'],{services:{transport:{tail_lift:true}},rules:{transport:liftRule}}),false,'гидроборт есть только у XL, а не у M');
  assert.equal(matching.matches(fleetServices,'transport','XL',['transport'],{services:{transport:{tail_lift:true}},rules:{transport:liftRule}}),true);
  const sized=await dispatch.transportSizes(fleetOrder);
  assert.deepEqual(sized.sizes.map(s=>[s.code,s.count]),[['S',1],['M',2],['L',1],['XL',1],['XXL',0]],'исполнитель с тремя машинами считается в каждом своём классе');
  assert.equal(sized.total,4);assert.equal(sized.unknown,1);
  // Списание одно на заявку: получил по классу M — в рассылку той же заявки классу XL уже не входит.
  const balance=async()=>(await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[fleet.id])).rows[0].balance_tetri;
  const before=await balance(),planM=await dispatch.preview(fleetOrder.token,'transport','M');
  await dispatch.dispatch(fleetOrder.token,'transport','M',{price:planM.price,count:planM.count,revision:0});
  assert.equal(await balance(),before-planM.price);
  const planXL=await dispatch.preview(fleetOrder.token,'transport','XL');
  assert.equal(planXL.recipients.some(m=>m.id===fleet.id),false);assert.equal(planXL.alreadyReceived,1);
  await assert.rejects(()=>dispatch.dispatch(fleetOrder.token,'transport','XL',{price:planXL.price,count:planXL.count,revision:0}),/уже получили эту заявку/);
  assert.equal(await balance(),before-planM.price,'второго списания за ту же заявку нет');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge'",[fleet.id,fleetOrder.id])).rows[0].n,1);

  // Смена порогов: буквы по записанным размерам пересчитываются, выбранные на глаз остаются.
  const thresholds=Object.fromEntries(config.VAN_SIZES.map(s=>[s.code,{length:s.length,width:s.width,height:s.height}]));
  thresholds.M.length=300;
  await settings.setVanSizeThresholds(thresholds);
  assert.equal(await masters.reclassifyVanSizes(),2);
  assert.equal((await van(measured.id)).size,'S');assert.equal(await legacy(measured.id),'S');
  assert.equal((await van(estimated.id)).size,'L');
  assert.equal((await van(managed.id)).size,'XL');
  assert.deepEqual(config.vanVehicles(await van(fleet.id)).map(v=>v.size),['S','S','XL'],'у исполнителя с несколькими машинами пересчитана каждая с размерами');
  assert.equal(await masters.reclassifyVanSizes(),0,'повторный пересчёт ничего не меняет');
  // Новое сохранение считает по действующим порогам, не по значениям из кода.
  const later=await register();
  await save(later,body('280','170','170'),null);
  assert.equal((await van(later.id)).size,'S');

  // Блок формы: сохранённые размеры подставлены, скрипт превью синтаксически цел.
  const sizes=await settings.getVanSizeThresholds();
  const html=await require('ejs').renderFile(path.join(__dirname,'../src/views/admin/_master-service-fields.ejs'),{
    master:{vehicle_size:'XL',services:[{service_type:'van',attributes:await van(managed.id)}]},
    serviceConfig:await require('../src/services/category.service').configForView('ru'),
    vanSizes:sizes.map(s=>({...s,spec:config.vanSizeSpec(s.code,sizes)})),
  });
  assert.match(html,/name="van_cargo_length_cm" data-van-cm min="1" max="2000" step="1" value="400"/);
  assert.match(html,/<option value="M" >M — от Д300×Ш130×В150 см<\/option>/);
  assert.match(html,/<option value="XL" selected>/);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
  // Список машин в форме: первая — прежними полями, остальные — van_more_<номер>_*, заготовка для «Добавить машину».
  const fleetHtml=await require('ejs').renderFile(path.join(__dirname,'../src/views/admin/_master-service-fields.ejs'),{
    master:{vehicle_size:'S',services:[{service_type:'van',attributes:await van(fleet.id)}]},
    serviceConfig:await require('../src/services/category.service').configForView('ru'),
    vanSizes:sizes.map(s=>({...s,spec:config.vanSizeSpec(s.code,sizes)})),maxVanVehicles:config.MAX_VAN_VEHICLES,
  });
  const count=text=>fleetHtml.split(text).length-1;
  assert.equal(count('data-van-vehicle="'),4,'три машины и заготовка');
  assert.match(fleetHtml,/name="van_more_1_cargo_length_cm" data-van-cm min="1" max="2000" step="1" value="280"/);
  assert.match(fleetHtml,/<select name="van_more_2_size" data-van-manual[^>]*>\s*<option value="">Размер неизвестен<\/option>[\s\S]*?<option value="XL" selected>/);
  assert.match(fleetHtml,/<select name="van_more_2_body" required[^>]*>[\s\S]*?<option value="flatbed" selected>/);
  assert.match(fleetHtml,/name="van_more_2_tail_lift" checked/);
  assert.match(fleetHtml,/name="van_more_INDEX_body"/);
  assert.equal(count('name="van_body"'),1);assert.equal(count('name="vehicleSize"'),1);assert.equal(count('name="van_with_helpers"'),1);
  assert.match(fleetHtml,/data-van-vehicles data-max="10"/);
  console.log('PASS: van body dimensions set the class, manual class only without dimensions, several vehicles per provider, order size choices, one charge per order, reclassify on threshold change');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
