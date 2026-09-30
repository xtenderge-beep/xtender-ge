// schema.sql выполняется при каждом старте. Старая миграция master_services добавляла «Перевозки»
// (van) каждому мастеру с category, отличной от movers, — исполнителям вывоза мусора, эвакуатора и
// автовышки — и возвращала её после того, как админ снимал услугу. Регрессия 2026-09-30.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const db=require('pg-mem').newDb();
const schema=fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8').replace(/\r\n/g,'\n');
db.public.none(schema);
const start=schema.indexOf("DELETE FROM master_services\nWHERE service_type = 'van'");
assert.ok(start>0,'migration block found');
const end=schema.indexOf('ON CONFLICT (master_id, service_type) DO NOTHING;',start)+'ON CONFLICT (master_id, service_type) DO NOTHING;'.length;
const migration=schema.slice(start,end);
const master=(phone,category)=>db.public.one(`INSERT INTO masters(name,phone,category,is_active) VALUES('M','${phone}',${category?`'${category}'`:'NULL'},true) RETURNING id`).id;
const service=(id,type,primary=true)=>db.public.none(`INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES(${id},'${type}','{}',${primary})`);
const types=id=>db.public.many(`SELECT service_type FROM master_services WHERE master_id=${id}`).map(r=>r.service_type).sort();

const junkWithStray=master('+995500000801','junk');service(junkWithStray,'junk');service(junkWithStray,'van');
const vanAndJunk=master('+995500000802','transport');service(vanAndJunk,'van');service(vanAndJunk,'junk',false);
const legacyJunk=master('+995500000803','junk');
const tow=master('+995500000804','tow');service(tow,'tow');
const noCategory=master('+995500000805',null);

db.public.none(migration);db.public.none(migration);

assert.deepEqual(types(junkWithStray),['junk'],'stray van removed from a junk provider');
assert.deepEqual(types(vanAndJunk),['junk','van'],'a real transport provider keeps both services');
assert.deepEqual(types(legacyJunk),['van'],'a legacy profile without services still gets its van row');
assert.deepEqual(types(tow),['tow'],'no van added back to a tow provider on restart');
assert.deepEqual(types(noCategory),[],'profiles without a category are left alone');
console.log('PASS: restart no longer adds «Перевозки» to junk/tow providers, stray rows removed, real transport and legacy profiles kept');
