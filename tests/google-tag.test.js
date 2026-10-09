// Google Analytics: метка только на открытых страницах, в Google уходит адрес без служебных параметров,
// сотрудники и роботы не считаются, переход в заявку или кабинет не зависит от ответа Google.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),ejs=require('ejs');
const tag=require('../src/config/googleTag');
const ID='G-TEST123456';

// Идентификатор: переменная окружения важнее; на локальной копии — только заданный явно; мусор не принимается.
assert.equal(tag.resolveId({GA_MEASUREMENT_ID:ID}),ID);
assert.equal(tag.resolveId({GA_MEASUREMENT_ID:' '+ID+' ',NODE_ENV:'development'}),ID);
assert.equal(tag.resolveId({NODE_ENV:'development'}),'');
assert.equal(tag.resolveId({GA_MEASUREMENT_ID:''}),'');
for(const bad of ['UA-1234-1','G-abc','"><script>','GTM-ABCDE']) assert.equal(tag.resolveId({GA_MEASUREMENT_ID:bad}),'',bad);

// Открытые страницы получают метку; страницы с секретными ссылками в адресе, кабинеты и админка — нет.
for(const p of ['/','/ru','/en/','/join','/ru/join','/en/guides/request','/terms','/ru/privacy','/s/avejis-gadazidva','/ru/s/tvirtis-gadazidva','/en/s/a1/']) assert.equal(tag.idFor(p,ID),ID,p);
for(const p of ['/o/SECRET','/order/abc','/master','/master/tok','/master/tok/topups/5','/review/tok','/my-orders','/z/tok','/admin',
  '/manager/orders','/ru/o/x','/joinx','/de/join','/s','/s/','/s/Tok_en','/s/a/b','/sx/a']) assert.equal(tag.idFor(p,ID),'',p);
assert.equal(tag.idFor('/',''),'');

const views=path.join(__dirname,'../src/views'),view=f=>fs.readFileSync(path.join(views,f),'utf8');
const partial=path.join(views,'partials/google-tag.ejs'),render=locals=>ejs.render(view('partials/google-tag.ejs'),locals,{filename:partial});
assert.match(render({googleTagId:ID}),/<script src="\/js\/google-tag\.js" data-id="G-TEST123456" defer><\/script>/);
assert.ok(!render({googleTagId:''}).includes('<script'));assert.ok(!render({}).includes('<script'),'шаблон без идентификатора рендерится без метки');
for(const f of ['partials/head.ejs','terms.ejs','privacy.ejs']) assert.match(view(f),/include\('(partials\/)?google-tag'\)/,f);

// Скрипт страницы в подставном браузере.
const source=fs.readFileSync(path.join(__dirname,'../public/js/google-tag.js'),'utf8');
function browser({href='https://xtender.ge/ru',referrer='',staff=false,webdriver=false,id=ID,readyState='complete'}={}){
  const url=new URL(href),scripts=[],timers=[],listeners={},window={addEventListener:(type,fn)=>{listeners[type]=fn;}};
  vm.runInContext(source,vm.createContext({window,URLSearchParams,Date,encodeURIComponent,setTimeout:(fn,ms)=>{timers.push({fn,ms});},
    location:{origin:url.origin,pathname:url.pathname,search:url.search},navigator:{webdriver},
    localStorage:{getItem:key=>(key==='xt_staff'&&staff?'1':null)},
    document:{referrer,readyState,currentScript:{getAttribute:()=>id},createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}}}));
  return {window,scripts,timers,listeners,sent:()=>Array.from(window.dataLayer||[],args=>Array.from(args))};
}

// Из адреса остаются только рекламные метки; ссылка менеджера, промокод и ключ заявки в Google не уходят.
let b=browser({href:'https://xtender.ge/ru/join?ref=MANAGERTOKEN&promo=PROMOCODE&utm_source=google&utm_campaign=movers&gclid=abc&gad_source=1&k=LEADKEY',
  referrer:'https://xtender.ge/o/SECRET-OWNER-LINK'});
let config=b.sent().find(e=>e[0]==='config');
assert.equal(config[1],ID);
assert.deepEqual({...config[2]},{page_location:'https://xtender.ge/ru/join?utm_source=google&utm_campaign=movers&gclid=abc&gad_source=1',
  allow_google_signals:false,allow_ad_personalization_signals:false,page_referrer:'https://xtender.ge/'});
for(const secret of ['MANAGERTOKEN','PROMOCODE','LEADKEY','SECRET-OWNER-LINK']) assert.ok(!JSON.stringify(b.sent()).includes(secret),secret);
assert.equal(b.scripts.length,1);assert.equal(b.scripts[0].src,'https://www.googletagmanager.com/gtag/js?id='+ID);assert.equal(b.scripts[0].async,true);
// Чужой сайт как источник перехода Google определяет сам; страница без параметров уходит без «?».
b=browser({href:'https://xtender.ge/',referrer:'https://www.google.com/'});config=b.sent().find(e=>e[0]==='config');
assert.equal(config[2].page_location,'https://xtender.ge/');assert.equal('page_referrer' in config[2],false);
// Библиотека Google грузится после загрузки страницы.
b=browser({readyState:'loading'});assert.equal(b.scripts.length,0);b.listeners.load();assert.equal(b.scripts.length,1);

// Сотрудник, робот и страница без идентификатора: в Google ничего не уходит, а страница продолжает работать.
for(const off of [{staff:true},{webdriver:true},{id:''}]){
  b=browser(off);let calls=0;
  assert.equal(b.window.dataLayer,undefined,JSON.stringify(off));assert.equal(b.scripts.length,0);
  b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{calls++;});assert.equal(calls,1);
  b.window.xtTrack('lead_form_start');
}

// Событие шага уходит сразу. Событие перед переходом ждёт отправки, но не дольше 0,8 с и только если библиотека загрузилась.
b=browser();
b.window.xtTrack('lead_form_start');
assert.deepEqual(b.sent().filter(e=>e[0]==='event').map(e=>[e[1],{...e[2]}]),[['lead_form_start',{}]]);
let done=0;
b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{done++;});
assert.equal(done,1,'библиотека Google не загрузилась (блокировщик) — переход не ждёт');assert.equal(b.timers.length,0);
b.scripts[0].onload();
done=0;const params={lead_type:'order'};
b.window.xtTrack('generate_lead',params,()=>{done++;});
assert.equal(done,0);assert.deepEqual(params,{lead_type:'order'},'параметры вызывающего не меняются');
let event=b.sent().filter(e=>e[1]==='generate_lead').pop()[2];
assert.equal(event.lead_type,'order');assert.equal(b.timers.length,1);assert.equal(b.timers[0].ms,800);
event.event_callback();assert.equal(done,1);b.timers[0].fn();assert.equal(done,1,'продолжение вызывается один раз');
done=0;b.window.xtTrack('sign_up',{method:'sms'},()=>{done++;});
b.timers[1].fn();assert.equal(done,1,'Google не ответил за 0,8 с — переход всё равно происходит');
b.sent().filter(e=>e[1]==='sign_up').pop()[2].event_callback();assert.equal(done,1);

// Шаги размечены в шаблонах; конверсия уходит до перехода на страницу с секретной ссылкой; личных данных в событиях нет.
const home=view('index.ejs'),join=view('join.ejs');
for(const name of ['lead_form_start','lead_form_phone_step','lead_form_code_sent','generate_lead','catalog_contact_start','catalog_code_sent','catalog_contact_open'])
  assert.ok(home.includes("'"+name+"'"),name);
for(const name of ['provider_signup_start','provider_signup_code_sent','sign_up']) assert.ok(join.includes("'"+name+"'"),name);
assert.ok(home.indexOf("await trackSent('generate_lead'")<home.indexOf('window.location.href = data.ownerLink')&&home.includes("await trackSent('generate_lead'"));
assert.ok(join.indexOf("await trackSent('sign_up'")<join.indexOf('window.location.href = data.link')&&join.includes("await trackSent('sign_up'"));
for(const call of (home+join).match(/(?:trackStep|trackSent|xtTrack)\('[a-z_]+'[^)]*\)/g)) assert.ok(!/phone|description|token|masterId|code\b/i.test(call.replace(/^[A-Za-z.]+\('[a-z_]+'/,'')),call);

// Политика конфиденциальности называет Google Analytics на трёх языках, в данных и в получателях.
const legal=require('../src/config/legal-content');
for(const lang of ['ka','ru','en']) assert.equal(JSON.stringify(legal.privacy.body[lang]).split('Google Analytics').length-1,2,lang);
console.log('PASS: Google Analytics tag: public pages only, cleaned address, staff and robots skipped, conversions sent before leaving the page');
