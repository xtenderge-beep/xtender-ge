// Показ номера в каталоге платный, поэтому до показа карточка знает только начало номера,
// а номер в описании или цене отклоняется при сохранении и скрывается при показе.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
let queue=Promise.resolve();pool.withTransaction=fn=>{const run=queue.then(async()=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}});queue=run.catch(()=>{});return run;};
const stub=(name,exports)=>require.cache[require.resolve(name)]={exports};stub('../src/config/db',pool);
const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const {hasPhone,maskPhones}=require('../src/config/phoneInText'),contacts=require('../src/config/catalogContacts');
const service=require('../src/services/master.service'),controller=require('../src/controllers/master.controller');
const managerPortal=require('../src/services/managerPortal.service'),{clientStrings}=require('../src/config/i18n');
(async()=>{
 for(const text of ['+995 599 12 34 56','599-12-34-56','599123456','5 9 9 1 2 3 4 5 6','0322 12 34 56','(599) 12 34 56','+995(599)123456','звоните 599.12.34.56'])assert.equal(hasPhone(text),true,text);
 for(const text of ['Кузов 310×200×40 см','Кузов 310 200 40','от 60 GEL / рейс','Работаем с 2015, 2016 года','Грузоподъёмность 3000 кг','24/7','',null])assert.equal(hasPhone(text),false,String(text));
 assert.equal(maskPhones('Звоните 599 12 34 56 в любое время'),'Звоните ••• в любое время');
 assert.equal(contacts.maskedPhone('+995599123456'),'+995 599 12 •• ••');
 assert.equal(contacts.formattedPhone('+995599123456'),'+995 599 12 34 56');
 assert.equal(contacts.maskedPhone('+1234567890'),'+123456 •• ••');assert.equal(contacts.maskedPhone(''),null);

 const m=(await pool.query("INSERT INTO masters(name,phone,category,is_active,description,price_text,description_source_lang,description_translations) VALUES('Phone Test','+995599123456','movers',true,'Вывоз мусора, тел 599 12 34 56','60 GEL, 599123456','ru',$1::jsonb) RETURNING *",[JSON.stringify({en:'Junk removal, call 599 12 34 56'})])).rows[0];
 await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[m.id]);
 const [ru]=await service.listMasters({language:'ru'}),[en]=await service.listMasters({language:'en'});
 assert.equal(ru.description,'Вывоз мусора, тел •••');assert.equal(en.description,'Junk removal, call •••');assert.equal(ru.price_text,'60 GEL, •••');
 assert.equal(ru.phone_masked,'+995 599 12 •• ••');
 let body;await controller.list({query:{},lang:'ru'},{json:b=>{body=b;}});
 assert.equal(body.masters[0].phone,undefined);assert.doesNotMatch(JSON.stringify(body),/3456/,'no full number in the public API');

 await assert.rejects(service.registerMaster({name:'New',phone:'+995599000001',description:'Звоните +995 599 00 00 01'}),{code:'DESCRIPTION_HAS_PHONE'});
 assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM masters WHERE phone='+995599000001'")).rows[0].n,0);
 await assert.rejects(service.updateMasterProfile(m.id,{name:m.name,phone:m.phone,category:'movers',description:'Новый текст 599-12-34-56',services:[{type:'movers',attributes:{crew_size:2}}]}),{code:'DESCRIPTION_HAS_PHONE'});
 await assert.rejects(service.updateMasterProfile(m.id,{name:m.name,phone:m.phone,category:'movers',description:'Без номера',priceText:'599123456',services:[{type:'movers',attributes:{crew_size:2}}]}),{code:'DESCRIPTION_HAS_PHONE'});
 assert.equal((await pool.query('SELECT description FROM masters WHERE id=$1',[m.id])).rows[0].description,'Вывоз мусора, тел 599 12 34 56');
 await assert.rejects(managerPortal.updateDescription(1,m.id,'Пишите 599 12 34 56','ru'),{status:400});

 for(const lang of ['ru','en','ka']){
  const res={status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
  await controller.register({lang,body:{phone:'+995599000002',name:'X',description:'Звоните 599 00 00 02',spokenLanguages:['ru']},cookies:{}},res);
  assert.equal(res.code,400);assert.equal(res.data.message,clientStrings(lang).join_description_phone);assert.ok(res.data.message);
 }
 console.log('PASS: phone formats and false positives, masked catalog number, masked legacy descriptions and translations, public API without the number, rejection on signup, admin/manager edit and signup API');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
