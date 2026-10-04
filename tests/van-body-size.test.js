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

  // Смена порогов: буквы по записанным размерам пересчитываются, выбранные на глаз остаются.
  const thresholds=Object.fromEntries(config.VAN_SIZES.map(s=>[s.code,{length:s.length,width:s.width,height:s.height}]));
  thresholds.M.length=300;
  await settings.setVanSizeThresholds(thresholds);
  assert.equal(await masters.reclassifyVanSizes(),1);
  assert.equal((await van(measured.id)).size,'S');assert.equal(await legacy(measured.id),'S');
  assert.equal((await van(estimated.id)).size,'L');
  assert.equal((await van(managed.id)).size,'XL');
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
  console.log('PASS: van body dimensions set the class, manual class only without dimensions, order size choices, reclassify on threshold change');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
