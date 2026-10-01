// «Вывоз мусора» выполняет любая машина: как грузить и выгружать, решает исполнитель. Самосвальный
// кузов важен, только когда груз надо высыпать или заказчик прямо просит самосвал, — это
// необязательная отметка. До 2026-10-01 категория называлась «Вывоз мусора (самосвал)»; обязательный
// список «Тип машины» (vehicle_kind) прожил несколько часов и заменён этой отметкой.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const db=require('pg-mem').newDb();
const schema=fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8').replace(/\r\n/g,'\n');
db.public.none(schema);
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
require.cache[require.resolve('../src/config/db')]={exports:pool};
const junkBody=require('../src/config/junkBody'),categories=require('../src/services/category.service');
const needs=require('../src/services/serviceRequirements.service'),matching=require('../src/services/serviceMatching.service');
const masters=require('../src/services/master.service');

(async()=>{
 // Название: чистая установка и обновление базы со старым названием; своё название админа не трогаем.
 const names=()=>db.public.one("SELECT name_ru,name_ka,name_en FROM service_categories WHERE slug='junk'");
 assert.deepEqual(names(),{name_ru:'Вывоз мусора',name_ka:'ნარჩენების გატანა',name_en:'Waste removal'});
 const rename=schema.split('\n').filter(line=>/^UPDATE service_categories SET name_(ru|ka|en)=.* WHERE slug='junk' AND name_/.test(line)).join('\n');
 assert.equal(rename.split('\n').length,3,'three guarded rename statements');
 db.public.none("UPDATE service_categories SET name_ru='Вывоз мусора (самосвал)',name_ka='ნარჩენების გატანა (თვითმცლელით)',name_en='Waste removal (dump truck)' WHERE slug='junk'");
 db.public.none(rename);db.public.none(rename);
 assert.deepEqual(names(),{name_ru:'Вывоз мусора',name_ka:'ნარჩენების გატანა',name_en:'Waste removal'});
 db.public.none("UPDATE service_categories SET name_ru='Вывоз строймусора' WHERE slug='junk'");
 db.public.none(rename);
 assert.equal(names().name_ru,'Вывоз строймусора','a name the admin set is kept on restart');
 db.public.none("UPDATE service_categories SET name_ru='Вывоз мусора' WHERE slug='junk'");
 assert.equal((await categories.groups()).junk,'🧹 Вывоз мусора');

 // Отметка: необязательная галочка, фильтр каталога; у менеджера своя подпись и подсказка.
 const row=await categories.get('junk'),dump=row.fields.find(f=>f.key==='dump_body');
 assert.deepEqual([dump.input,dump.match,dump.filter,dump.required],['bool','flag',true,undefined]);
 assert.equal(dump.need.label,'Нужен самосвал');assert.match(dump.need.hint,/все, кто вывозит мусор/);
 assert.ok(row.fields.filter(f=>f.required).every(f=>f.key==='volume_m3'),'only the volume is required');
 for(const lang of ['ru','ka','en']) assert.ok(categories.view(row,lang).fields.find(f=>f.key==='dump_body').label,'label in '+lang);
 // Редактор категорий пересобирает поля и теряет подсказку: она должна вернуться при чтении.
 // Список типов, если категорию успели сохранить вместе с ним, из справочника исчезает.
 const stored={slug:'junk',fields:[{key:'vehicle_kind',input:'enum',options:['dump','van','flatbed'],match:'exact',required:true},...row.fields.map(({need,...field})=>field)]};
 const restored=junkBody.withBuiltInFields(stored).fields;
 assert.ok(!restored.some(f=>f.key==='vehicle_kind'));
 assert.equal(restored.filter(f=>f.key==='dump_body').length,1);
 assert.equal(restored.find(f=>f.key==='dump_body').need.label,'Нужен самосвал');

 // Подбор: без отметки в заявке её получают все; с отметкой — только самосвалы.
 const all=await categories.list();
 const dumpOnly=needs.parse(all,['junk'],{junk:{dump_body:'on'}}),any=needs.parse(all,['junk'],{junk:{}});
 assert.deepEqual(dumpOnly.services.junk,{dump_body:true});
 assert.throws(()=>needs.parse(all,['junk'],{junk:{vehicle_kind:'dump'}}),/Неизвестная/);
 const provider=attributes=>[{service_type:'junk',attributes}];
 const truck=provider({dump_body:true,volume_m3:'8'}),van=provider({dump_body:false,volume_m3:'4'}),old=provider({volume_m3:'8'});
 assert.equal(matching.matches(truck,'junk','',['junk'],dumpOnly),true);
 assert.equal(matching.matches(van,'junk','',['junk'],dumpOnly),false);
 assert.equal(matching.matches(old,'junk','',['junk'],dumpOnly),false,'a profile saved before the mark is not a dump truck');
 for(const services of [truck,van,old]) assert.equal(matching.matches(services,'junk','',['junk'],any),true);
 // Фургон с услугами «Перевозки» и «Вывоз мусора» получает заявки обеих категорий.
 const both=[{service_type:'van',attributes:{size:'M',body:'closed'}},...van];
 assert.equal(matching.matches(both,'transport','M',['transport'],{}),true);
 assert.equal(matching.matches(both,'junk','',['junk'],any),true);

 // Карточка каталога и сохранение профиля: отметка не обязательна, одобрение не блокируется.
 assert.deepEqual(categories.badges(row,{dump_body:true,volume_m3:'8'},'ru'),['Самосвал','Объём: 8+ м³']);
 assert.deepEqual(categories.badges(row,{dump_body:true,volume_m3:'8'},'ka'),['თვითმცლელი','მოცულობა: 8+ მ³']);
 assert.deepEqual(categories.badges(row,{dump_body:false,volume_m3:'4'},'ru'),['Объём: 4+ м³']);
 assert.deepEqual(categories.badges({slug:'junk'},{volume_m3:'8'},'ru'),['Объём: 8+ м³']);
 const m=await masters.registerMaster({name:'Ford Transit',phone:'+995500007701',serviceType:null});
 const profile=attributes=>masters.updateMasterProfile(m.id,{name:m.name,phone:m.phone,vehicleSize:'M',services:[{type:'van',attributes:{body:'closed'}},{type:'junk',attributes}]});
 const junkAttributes=async()=>(await pool.query("SELECT attributes FROM master_services WHERE master_id=$1 AND service_type='junk'",[m.id])).rows[0].attributes;
 await profile({volume_m3:'4'});
 assert.deepEqual(await junkAttributes(),{volume_m3:'4',dump_body:false});
 assert.deepEqual((await pool.query('SELECT category,vehicle_size FROM masters WHERE id=$1',[m.id])).rows[0],{category:'transport',vehicle_size:'M'});
 assert.equal((await masters.approveMaster(m.id)).is_active,true);
 await profile({volume_m3:'4',dump_body:'on',vehicle_kind:'van'});
 assert.deepEqual(await junkAttributes(),{volume_m3:'4',dump_body:true},'the retired key is not written back');

 // Отметку нельзя удалить из справочника, остальное редактируется как раньше.
 const form=fields=>({name_ru:row.name_ru,name_ka:row.name_ka,name_en:row.name_en,icon:row.icon,sort_order:row.sort_order,is_active:true,version:row.version,fields});
 const editable=row.fields.map(f=>({key:f.key,input:f.input,name_ru:f.labels.ru,name_ka:f.labels.ka,name_en:f.labels.en,required:f.required===true,match:f.match,filter:f.filter===true,unit:f.unit,min:f.min,max:f.max,
  options:(f.options||[]).map(v=>({value:v,name_ru:f.optionLabels[v].ru,name_ka:f.optionLabels[v].ka,name_en:f.optionLabels[v].en}))}));
 await assert.rejects(()=>categories.save('junk',form(editable.filter(f=>f.key!=='dump_body'))),{status:409});
 await categories.save('junk',form(editable));
 const resaved=(await categories.get('junk')).fields.find(f=>f.key==='dump_body');
 assert.deepEqual([resaved.input,resaved.match,resaved.need.label],['bool','flag','Нужен самосвал']);
 console.log('PASS: junk category renamed, dump mark optional and matched as a flag, moderator hint survives a category edit');
})().catch(e=>{console.error(e);process.exitCode=1;});
