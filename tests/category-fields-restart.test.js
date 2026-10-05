// schema.sql выполняется при каждом старте. До 2026-10-05 он безусловно перезаписывал характеристики
// «Перевозок» значениями из кода: правка администратора в /admin/categories/van пропадала с каждой
// выкладкой, а добавленное им поле исчезало из справочника.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const db=require('pg-mem').newDb();
const schema=fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8').replace(/\r\n/g,'\n');
db.public.none(schema);
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
require.cache[require.resolve('../src/config/db')]={exports:pool};
const categories=require('../src/services/category.service');
// Все операторы файла, которые пишут в справочник услуг: при старте они выполняются снова.
const start=schema.indexOf('INSERT INTO service_categories(slug'),end=schema.indexOf('-- Parallel technical requests.');
assert.ok(start>0 && end>start,'service category statements found');
const restart=()=>db.public.none(schema.slice(start,end));
const form=f=>({key:f.key,input:f.input,name_ru:f.labels.ru,name_ka:f.labels.ka,name_en:f.labels.en,match:f.match,required:f.required===true,filter:f.filter===true,
  options:(f.options||[]).map(value=>({value,name_ru:f.optionLabels?.[value]?.ru||value,name_ka:f.optionLabels?.[value]?.ka,name_en:f.optionLabels?.[value]?.en}))});
const edit=async(slug,change)=>{
  const row=await categories.get(slug),fields=row.fields.filter(f=>f.input!=='size').map(form);
  change(fields);
  return categories.save(slug,{name_ru:row.name_ru,name_ka:row.name_ka,name_en:row.name_en,icon:row.icon,sort_order:row.sort_order,is_active:true,version:row.version,fields});
};
(async()=>{
  // Свежая база получает класс M из INSERT, отдельная миграция для этого не нужна.
  assert.deepEqual((await categories.get('van')).fields.find(f=>f.input==='size').options,['S','M','L','XL','XXL']);
  const saved=await edit('van',fields=>{
    fields.find(f=>f.key==='with_helpers').name_ru='Водитель помогает грузить';
    fields.push({input:'bool',name_ru:'Рефрижератор',match:'flag',filter:true});
  });
  const added=saved.fields.find(f=>f.labels.ru==='Рефрижератор').key;
  const junk=await edit('junk',fields=>{fields.find(f=>f.key==='payload_t').name_ru='Сколько тонн берёт';});
  restart();restart();
  const van=await categories.get('van');
  assert.equal(van.fields.find(f=>f.key==='with_helpers').labels.ru,'Водитель помогает грузить','переименованная характеристика «Перевозок» пережила перезапуск');
  assert.ok(van.fields.some(f=>f.key===added),'добавленная администратором характеристика «Перевозок» пережила перезапуск');
  assert.deepEqual(van.fields.find(f=>f.input==='size').options,['S','M','L','XL','XXL']);
  assert.deepEqual(van.fields.find(f=>f.key==='body').options,['closed','flatbed']);
  assert.equal(van.version,saved.version);
  assert.equal((await categories.get('junk')).fields.find(f=>f.key==='payload_t').labels.ru,'Сколько тонн берёт','правка другой встроенной услуги тоже на месте');
  assert.equal((await categories.get('junk')).version,junk.version);
  assert.equal((await categories.list()).length,5,'перезапуск не добавил и не убрал услуги');
  console.log('PASS: admin edits of built-in service characteristics survive a restart, fresh database still has the M class');
})().catch(e=>{console.error(e);process.exitCode=1;});
