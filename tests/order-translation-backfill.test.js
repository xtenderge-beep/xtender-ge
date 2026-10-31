// Открытая заявка без перевода (сбой OpenRouter, нерабочий ключ, правка заказчиком) догоняется фоновым
// проходом; закрытые и неподтверждённые не трогаем, готовые не переводим повторно, старый текст не сохраняем.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);
const real=require('../src/services/translation.service');
const calls=[];let failing=false,partial=false,beforeSave=null;
stub('../src/services/translation.service',{...real,translateOrder:async text=>{
  calls.push(text);if(failing)return null;if(beforeSave)await beforeSave();
  const sourceLang=real.detectLang(text);
  const targets=['ka','ru','en'].filter(l=>l!==sourceLang);
  return {sourceLang,translations:Object.fromEntries((partial?targets.slice(0,1):targets).map(l=>[l,l+': '+text]))};
}});
const auto=require('../src/services/orderTranslation.service');
let seq=0;
const add=async(description,status='new',extra={})=>(await pool.query(
  'INSERT INTO orders(token,owner_token,phone,description,status,source_lang,description_translations) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id',
  ['t'+(++seq),'o'+seq,'+995500007001',description,status,extra.source||null,JSON.stringify(extra.translations||{})])).rows[0].id;
const row=async id=>(await pool.query('SELECT description,source_lang,description_translations FROM orders WHERE id=$1',[id])).rows[0];
(async()=>{
 const KA='მჭირდება მუშები ვაკეში';
 const open=await add(KA);
 const review=await add('Нужны грузчики в Ваке','pending_review');
 const closed=await add('Заявка уже закрыта','closed');
 const draft=await add('Заявка ещё не подтверждена','unverified');
 const revision=await add('Заявка на доработке','needs_revision');
 const done=await add('Заявка уже переведена','new',{source:'ru',translations:{ka:'x',en:'y'}});

 // Сбой ничего не портит, следующий проход доводит дело до конца.
 failing=true;assert.deepEqual(await auto.backfill(),{pending:2,done:0});
 assert.deepEqual((await row(open)).description_translations,{});
 failing=false;calls.length=0;assert.deepEqual(await auto.backfill(),{pending:2,done:2});
 const translated=await row(open);
 assert.equal(translated.source_lang,'ka');
 assert.deepEqual(translated.description_translations,{ru:'ru: '+KA,en:'en: '+KA});
 assert.equal((await row(review)).source_lang,'ru');
 for(const id of [closed,draft,revision]) assert.deepEqual((await row(id)).description_translations,{},'only open orders are translated');
 assert.deepEqual((await row(done)).description_translations,{ka:'x',en:'y'},'finished translation is untouched');
 assert.equal(calls.length,2,'one call per order that needs it');

 // Готовые заявки не оплачиваются повторно.
 calls.length=0;assert.deepEqual(await auto.backfill(),{pending:0,done:0});assert.equal(calls.length,0);

 // Заказчик исправил заявку: страница задала source_lang языком страницы, перевод стёрт.
 const revised=await add('Исправленный текст заявки','pending_review',{source:'ka'});
 await auto.backfill();
 assert.equal((await row(revised)).source_lang,'ru','language comes from the text');
 assert.deepEqual(Object.keys((await row(revised)).description_translations).sort(),['en','ka']);

 // Нет одного языка: заявка остаётся в проходе, полученный язык сохраняется и не теряется при сбое.
 partial=true;const half=await add('Заявка с одним языком');await auto.backfill();
 assert.deepEqual(Object.keys((await row(half)).description_translations),['ka']);
 assert.equal(auto.isTranslated(await row(half)),false);
 partial=false;await auto.backfill();assert.deepEqual(Object.keys((await row(half)).description_translations).sort(),['en','ka']);

 // Старая запись на исходном языке заменила бы на странице оригинал заказчика.
 const stale=await add('Текст старой заявки','new',{source:'ka',translations:{ru:'Искажённый текст',en:'Old'}});
 await auto.backfill();
 assert.deepEqual(Object.keys((await row(stale)).description_translations).sort(),['en','ka'],'source language entry is removed');

 // Текст поменялся, пока шёл перевод: перевод старого текста не сохраняется.
 const racing=await add('Старый текст заявки');
 beforeSave=()=>pool.query("UPDATE orders SET description='Новый текст заявки' WHERE id=$1",[racing]);
 assert.deepEqual(await auto.backfill(),{pending:1,done:0});
 beforeSave=null;
 assert.deepEqual((await row(racing)).description_translations,{});
 await auto.backfill();
 assert.equal((await row(racing)).description_translations.en,'en: Новый текст заявки');

 // За один проход не больше лимита, сначала самые новые.
 const ids=[];for(let i=0;i<3;i++) ids.push(await add('Пачка заявок номер '+i));
 assert.deepEqual(await auto.backfill(2),{pending:2,done:2});
 assert.deepEqual(await Promise.all(ids.map(async id=>Object.keys((await row(id)).description_translations).length)),[0,2,2]);
 console.log('PASS: open orders without a translation are caught up; closed ones and finished translations are left alone');
})().catch(e=>{console.error(e);process.exit(1);});
