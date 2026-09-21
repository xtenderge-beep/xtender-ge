const assert = require('node:assert/strict');
const fs = require('fs');
const {newDb} = require('pg-mem');
const {parse} = require('../src/config/spokenLanguages');
assert.deepEqual(parse('ka'), ['ka']);
assert.deepEqual(parse(['ru','en','ru']), ['ru','en']);
for (const value of [undefined, [], ['xx'], ['ka', {}], '__proto__']) assert.equal(parse(value), null);
const db = newDb();
const schema = fs.readFileSync(require('path').join(__dirname,'../schema.sql'),'utf8');
db.public.none(schema);
const {Pool} = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => {const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
require.cache[require.resolve('../src/config/db')] = {exports:pool};
const {registerMaster} = require('../src/services/master.service');
(async () => {
  const args={name:'Languages',phone:'+995500000333',serviceType:'movers'};
  const first=await registerMaster({...args,spokenLanguages:['ka','ru']});
  assert.deepEqual((await pool.query('SELECT spoken_languages FROM masters WHERE id=$1',[first.id])).rows[0].spoken_languages,['ka','ru']);
  await registerMaster({...args,spokenLanguages:['en']});
  assert.deepEqual((await pool.query('SELECT spoken_languages FROM masters WHERE id=$1',[first.id])).rows[0].spoken_languages,['en']);
  await registerMaster(args);
  assert.deepEqual((await pool.query('SELECT spoken_languages FROM masters WHERE id=$1',[first.id])).rows[0].spoken_languages,['en']);
  await assert.rejects(registerMaster({...args,spokenLanguages:['invalid']}));
  const legacy=await registerMaster({...args,phone:'+995500000334'});
  assert.deepEqual(legacy.spoken_languages,[]);
  const ejs=require('ejs');
  for(const file of ['join.ejs','admin/master-detail.ejs']) ejs.compile(fs.readFileSync(require('path').join(__dirname,'../src/views',file),'utf8'));
  const {clientStrings}=require('../src/config/i18n');
  for(const lang of ['ka','ru','en']) assert.ok(clientStrings(lang).join_languages_required);
  // Язык сайта при регистрации: пишется один раз, повторная регистрация его не меняет,
  // а у профиля без записи он остаётся пустым, а не угадывается.
  const siteRow=async id=>(await pool.query('SELECT language, registration_language FROM masters WHERE id=$1',[id])).rows[0];
  const site={...args,phone:'+995500000335',name:'Site language'};
  const registered=await registerMaster({...site,language:'ru'});
  assert.deepEqual(await siteRow(registered.id),{language:'ru',registration_language:'ru'});
  await registerMaster({...site,language:'en'});
  assert.deepEqual(await siteRow(registered.id),{language:'en',registration_language:'ru'});
  assert.equal((await siteRow(legacy.id)).registration_language,null);
  await registerMaster({...args,phone:'+995500000334',language:'ka'});
  assert.equal((await siteRow(legacy.id)).registration_language,'ka');

  // Список в админке отдаёт языки, сводка не считает технические и забаненные аккаунты, фильтры работают.
  const adminService=require('../src/services/admin.service');
  const listed=await adminService.listMastersAdmin();
  assert.deepEqual(listed.find(m=>m.id===first.id).spoken_languages,['en']);
  assert.equal(listed.find(m=>m.id===first.id).registration_language,null);
  assert.equal(listed.find(m=>m.id===registered.id).registration_language,'ru');
  assert.deepEqual(listed.find(m=>m.id===registered.id).spoken_languages,[]);
  const rows=[
    {id:1,name:'Anna',spoken_languages:['ru','en'],registration_language:'ru'},
    {id:2,name:'Beka',spoken_languages:['ka'],registration_language:'ka'},
    {id:3,name:'Old',spoken_languages:[],registration_language:null},
    {id:4,name:'Test',is_technical:true,spoken_languages:['ru'],registration_language:'ru'},
    {id:5,name:'Banned',is_banned:true,spoken_languages:['ru'],registration_language:'ru'},
  ];
  const summary=adminService.languageSummary(rows);
  assert.equal(summary.total,3);
  assert.deepEqual([summary.spoken.ru,summary.spoken.en,summary.spoken.ka,summary.spokenNone],[1,1,1,1]);
  assert.deepEqual([summary.site.ru,summary.site.ka,summary.site.en,summary.siteNone],[1,1,undefined,1]);
  const ids=filter=>adminService.filterByLanguage(rows,filter).map(m=>m.id);
  assert.deepEqual(ids({}),[1,2,3,4,5]);
  assert.deepEqual(ids({lang:'ru'}),[1,4,5]);
  assert.deepEqual(ids({lang:'none'}),[3]);
  assert.deepEqual(ids({site:'ru'}),[1,4,5]);
  assert.deepEqual(ids({site:'none'}),[3]);
  assert.deepEqual(ids({lang:'ru',site:'ka'}),[]);
  assert.deepEqual(ids({lang:'en',site:'ru'}),[1]);
  const {ruNames}=require('../src/config/spokenLanguages');
  const views=require('path').join(__dirname,'../src/views');
  const render=filter=>ejs.render(fs.readFileSync(require('path').join(views,'admin/masters.ejs'),'utf8'),
    {masters:adminService.filterByLanguage(rows,filter).map(r=>({is_active:true,is_banned:false,balance_tetri:0,rating:0,review_count:0,last_topup_at:null,category:'movers',phone:'+995500000000',...r})),
      languageSummary:summary,languageNames:ruNames,filter:{status:'',lang:'',site:'',...filter},csrfToken:'csrf'},
    {filename:require('path').join(views,'admin/masters.ejs'),includer:(original,parsed)=>original==='./_header'||original==='./_footer'?{template:''}:{filename:parsed}});
  const all=render({});
  assert.match(all,/Русский <b>1<\/b>/);
  assert.match(all,/Не указали <b>1<\/b>/);
  assert.match(all,/Не записано <b>1<\/b>/);
  assert.match(all,/href="\/admin\/masters\?lang=ru"/);
  assert.match(all,/Говорит: <b class="text-stone-800">Русский, Английский<\/b>/);
  assert.match(all,/интерфейс при регистрации: <b class="text-stone-800">Грузинский<\/b>/);
  assert.match(all,/Говорит: не указано/);
  assert.match(all,/интерфейс при регистрации: не записан/);
  assert.doesNotMatch(all,/Сбросить фильтр языка/);
  const narrowed=render({lang:'ru',site:'ka'});
  assert.match(narrowed,/Сбросить фильтр языка/);
  assert.match(narrowed,/href="\/admin\/masters\?site=ka"/);
  assert.doesNotMatch(narrowed,/Anna/);
  console.log('PASS: language validation, persistence, re-registration, registration language, admin language list, legacy profiles, templates and translations');
})().catch(e=>{console.error(e);process.exitCode=1;});
