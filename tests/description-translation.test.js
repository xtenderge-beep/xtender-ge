// Описание исполнителя переводится автоматически при любом изменении (регистрация, правка
// админом) и фоновым проходом для старых профилей; перевод устаревшего текста не сохраняется.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const b=db.backup();try{return await fn(pool);}catch(e){b.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);stub('../src/config/redis',new(require('ioredis-mock'))());
const real=require('../src/services/translation.service');
const calls=[];let failing=false,beforeSave=null;
stub('../src/services/translation.service',{...real,translateProviderDescription:async(text,source)=>{
  calls.push(text);if(failing)return null;if(beforeSave)await beforeSave();
  const sourceLang=source||real.detectLang(text);
  return {sourceLang,translations:Object.fromEntries(['ka','ru','en'].filter(l=>l!==sourceLang).map(l=>[l,l+': '+text]))};
}});
const auto=require('../src/services/descriptionTranslation.service');
const masters=require('../src/services/master.service');
const row=async id=>(await pool.query('SELECT description,description_source_lang,description_translations FROM masters WHERE id=$1',[id])).rows[0];
(async()=>{
 // Старый профиль с грузинским описанием без перевода — как в каталоге на /ru.
 const old=(await pool.query("INSERT INTO masters(name,phone,description) VALUES('Shotiko','+995500001001','ავეჯის დატვირთვა') RETURNING id")).rows[0].id;
 const empty=(await pool.query("INSERT INTO masters(name,phone) VALUES('NoText','+995500001002') RETURNING id")).rows[0].id;
 const done=(await pool.query(`INSERT INTO masters(name,phone,description,description_source_lang,description_translations) VALUES('Done','+995500001003','Грузчики','ru','{"ka":"x","en":"y"}') RETURNING id`)).rows[0].id;
 assert.equal(auto.isTranslated(await row(old)),false);
 assert.equal(auto.isTranslated(await row(empty)),true);
 assert.equal(auto.isTranslated(await row(done)),true);

 // Сбой перевода ничего не портит, повторный проход доводит дело до конца.
 failing=true;assert.deepEqual(await auto.backfill(),{pending:1,done:0});
 assert.deepEqual((await row(old)).description_translations,{});
 failing=false;assert.deepEqual(await auto.backfill(),{pending:1,done:1});
 const translated=await row(old);
 assert.equal(translated.description_source_lang,'ka');
 assert.deepEqual(translated.description_translations,{ru:'ru: ავეჯის დატვირთვა',en:'en: ავეჯის დატვირთვა'});
 assert.equal(masters.descriptionFor(translated,'ru'),'ru: ავეჯის დატვირთვა','catalog shows the Russian translation on /ru');
 assert.equal(masters.descriptionFor(translated,'ka'),'ავეჯის დატვირთვა','original on its own language');
 calls.length=0;assert.deepEqual(await auto.backfill(),{pending:0,done:0});assert.equal(calls.length,0,'translated rows are not paid for again');

 // Описание поменялось, пока шёл перевод, — перевод старого текста не сохраняется.
 const racing=(await pool.query("INSERT INTO masters(name,phone,description) VALUES('Race','+995500001004','Старый текст') RETURNING id")).rows[0].id;
 beforeSave=()=>pool.query("UPDATE masters SET description='Новый текст' WHERE id=$1",[racing]);
 assert.equal(await auto.translateMaster(racing),false);
 beforeSave=null;
 assert.deepEqual((await row(racing)).description_translations,{});
 assert.equal(await auto.translateMaster(racing),true);
 assert.equal((await row(racing)).description_translations.en,'en: Новый текст');

 // Правка админом сбрасывает перевод, очередь переводит новый текст.
 await pool.query("INSERT INTO cities(id,slug,name_ru,name_ka,name_en,is_active) VALUES(1,'tbilisi','Тбилиси','თბილისი','Tbilisi',true) ON CONFLICT DO NOTHING");
 await masters.updateMasterProfile(old,{name:'Shotiko',phone:'+995500001001',category:'movers',description:'Грузчики, разборка мебели',services:[{type:'movers',attributes:{crew_size:'1'}}]});
 assert.deepEqual((await row(old)).description_translations,{},'admin edit clears stale translations');
 auto.queue(old);
 for(let i=0;i<50&&!Object.keys((await row(old)).description_translations).length;i++) await new Promise(r=>setTimeout(r,10));
 const edited=await row(old);
 assert.equal(edited.description_source_lang,'ru');
 assert.deepEqual(edited.description_translations,{ka:'ka: Грузчики, разборка мебели',en:'en: Грузчики, разборка мебели'});
 console.log('PASS: provider descriptions are auto-translated on change and by backfill; stale translations are never saved');
})().catch(e=>{console.error(e);process.exit(1);});
