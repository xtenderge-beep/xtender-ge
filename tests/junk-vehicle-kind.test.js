// «Вывоз мусора» выполняют не только самосвалы: фургон или бортовая берут мешки и мебель, мусор
// навалом берёт только самосвал. Тип машины — характеристика услуги, по ней модератор решает,
// кому отправить заявку. До 2026-10-01 категория называлась «Вывоз мусора (самосвал)».
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

 // Поле: первое в списке, обязательное, точное совпадение, фильтр каталога; подсказка модератору.
 const row=await categories.get('junk'),kind=row.fields[0];
 assert.equal(kind.key,'vehicle_kind');assert.deepEqual(kind.options,['dump','van','flatbed']);
 assert.equal(kind.required,true);assert.equal(kind.match,'exact');assert.equal(kind.filter,true);
 assert.equal(kind.need.anyLabel,'Любая машина');assert.match(kind.need.hint,/Самосвал/);
 for(const lang of ['ru','ka','en']) {
  const field=categories.view(row,lang).fields[0];
  assert.ok(field.label && field.options.every(o=>o.label && o.label!==o.value),'labels in '+lang);
 }
 // Редактор категорий пересобирает поля и теряет подсказку: она должна вернуться при чтении.
 const stored={slug:'junk',fields:row.fields.map(({need,...field})=>field)};
 assert.equal(junkBody.withBuiltInFields(stored).fields[0].need.anyLabel,'Любая машина');
 assert.equal(junkBody.withBuiltInFields(stored).fields.filter(f=>f.key==='vehicle_kind').length,1);

 // Подбор: «самосвал» получают только самосвалы; без ограничения — все, включая профили без типа.
 const all=await categories.list();
 const dumpOnly=needs.parse(all,['junk'],{junk:{vehicle_kind:'dump'}}),any=needs.parse(all,['junk'],{junk:{}});
 assert.deepEqual(dumpOnly.services.junk,{vehicle_kind:'dump'});
 assert.throws(()=>needs.parse(all,['junk'],{junk:{vehicle_kind:'bicycle'}}),/Некорректная/);
 const provider=attributes=>[{service_type:'junk',attributes}];
 const dump=provider({vehicle_kind:'dump',volume_m3:'8'}),van=provider({vehicle_kind:'van',volume_m3:'4'}),unknown=provider({volume_m3:'8'});
 assert.equal(matching.matches(dump,'junk','',['junk'],dumpOnly),true);
 assert.equal(matching.matches(van,'junk','',['junk'],dumpOnly),false);
 assert.equal(matching.matches(unknown,'junk','',['junk'],dumpOnly),false,'no guessed type for old profiles');
 for(const services of [dump,van,unknown]) assert.equal(matching.matches(services,'junk','',['junk'],any),true);
 // Фургон с услугами «Перевозки» и «Вывоз мусора» получает заявки обеих категорий.
 const both=[{service_type:'van',attributes:{size:'M',body:'closed'}},...van];
 assert.equal(matching.matches(both,'transport','M',['transport'],{}),true);
 assert.equal(matching.matches(both,'junk','',['junk'],any),true);

 // Карточка каталога и сохранение профиля.
 assert.deepEqual(categories.badges(row,{vehicle_kind:'van',volume_m3:'4'},'ru'),['Фургон','Объём: 4+ м³']);
 assert.deepEqual(categories.badges(row,{vehicle_kind:'dump',volume_m3:'8'},'ka'),['თვითმცლელი','მოცულობა: 8+ მ³']);
 assert.deepEqual(categories.badges({slug:'junk'},{volume_m3:'8'},'ru'),['Объём: 8+ м³']);
 const m=await masters.registerMaster({name:'Ford Transit',phone:'+995500007701',serviceType:null});
 const profile=attributes=>masters.updateMasterProfile(m.id,{name:m.name,phone:m.phone,vehicleSize:'M',services:[{type:'van',attributes:{body:'closed'}},{type:'junk',attributes}]});
 await assert.rejects(()=>profile({volume_m3:'4'}),{code:'INVALID_SERVICE'});
 await profile({vehicle_kind:'van',volume_m3:'4'});
 const saved=(await pool.query("SELECT attributes FROM master_services WHERE master_id=$1 AND service_type='junk'",[m.id])).rows[0].attributes;
 assert.deepEqual(saved,{vehicle_kind:'van',volume_m3:'4'});
 assert.deepEqual((await pool.query('SELECT category,vehicle_size FROM masters WHERE id=$1',[m.id])).rows[0],{category:'transport',vehicle_size:'M'});

 // Поле нельзя удалить из справочника, остальное редактируется как раньше.
 const form=fields=>({name_ru:row.name_ru,name_ka:row.name_ka,name_en:row.name_en,icon:row.icon,sort_order:row.sort_order,is_active:true,version:row.version,fields});
 const editable=row.fields.map(f=>({key:f.key,input:f.input,name_ru:f.labels.ru,name_ka:f.labels.ka,name_en:f.labels.en,required:f.required===true,match:f.match,filter:f.filter===true,unit:f.unit,min:f.min,max:f.max,
  options:(f.options||[]).map(v=>({value:v,name_ru:f.optionLabels[v].ru,name_ka:f.optionLabels[v].ka,name_en:f.optionLabels[v].en}))}));
 await assert.rejects(()=>categories.save('junk',form(editable.filter(f=>f.key!=='vehicle_kind'))),{status:409});
 await categories.save('junk',form(editable));
 const resaved=(await categories.get('junk')).fields.find(f=>f.key==='vehicle_kind');
 assert.deepEqual(resaved.options,['dump','van','flatbed']);assert.equal(resaved.need.anyLabel,'Любая машина');
 console.log('PASS: junk category renamed, vehicle kind required and matched exactly, moderator hint survives a category edit');
})().catch(e=>{console.error(e);process.exitCode=1;});
