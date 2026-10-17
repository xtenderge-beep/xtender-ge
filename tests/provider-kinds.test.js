// «Кто вы?» на /join: мастер, машина или магазин. Выбор сохраняется в masters.signup_kinds и виден
// модератору; неизвестное значение отклоняется, старая форма без поля регистрирует как раньше.
const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg();const pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
require.cache[require.resolve('../src/config/db')]={exports:pool};
const kinds=require('../src/config/providerKinds'),masters=require('../src/services/master.service');
const {translate}=require('../src/config/i18n');
const args=(phone,signupKinds)=>({phone,name:'Kinds test',description:'Test',serviceType:null,attributes:{},signupKinds});
(async()=>{
 assert.deepEqual(kinds.parse(undefined),[]);assert.deepEqual(kinds.parse(''),[]);
 assert.deepEqual(kinds.parse('store'),['store']);
 assert.deepEqual(kinds.parse(['store','worker','store']),['worker','store'],'known kinds, list order, no duplicates');
 assert.equal(kinds.parse(['store','admin']),null);assert.equal(kinds.parse('shop'),null);

 const store=await masters.registerMaster(args('+995500000201',['store']));
 const row=(await pool.query('SELECT * FROM masters WHERE id=$1',[store.id])).rows[0];
 assert.deepEqual(kinds.of(row),['store']);assert.deepEqual(kinds.labelsRu(row),['Строительный магазин']);
 const both=await masters.registerMaster(args('+995500000202',['worker','vehicle']));
 assert.deepEqual(kinds.labelsRu((await pool.query('SELECT * FROM masters WHERE id=$1',[both.id])).rows[0]),['Мастер или бригада','Машина или техника']);
 const old=await masters.registerMaster(args('+995500000203',null));
 assert.deepEqual(kinds.of((await pool.query('SELECT * FROM masters WHERE id=$1',[old.id])).rows[0]),[],'without the field the profile has no kinds');

 // Страница: три карточки и строка о бесплатном периоде на трёх языках.
 const html=fs.readFileSync(path.join(__dirname,'../src/views/join.ejs'),'utf8');
 for(const kind of kinds.KINDS) assert.ok(html.includes("kind: '"+kind+"'"),kind);
 for(const lang of ['ka','ru','en']) {
   const t=translate(lang);
   for(const key of ['join_free_title','join_free_lead','join_kind_title','join_kind_required','join_name_store_label','join_free_card_title'])
     assert.ok(typeof t(key)==='string'&&t(key)!==key,lang+':'+key);
   for(const kind of kinds.KINDS) assert.ok(t('join_kind_examples')[kind].body,lang+':example '+kind);
 }
 console.log('PASS: kinds parsing, saved on registration, admin labels, page cards and copy in three languages');
})().catch(e=>{console.error(e);process.exit(1);});
