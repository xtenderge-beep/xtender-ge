// Пиксель Meta: только на открытых страницах; на просмотре со ссылкой менеджера, промокодом или после
// страницы заявки не включается; сотрудники и роботы не считаются; в Meta уходят просмотр и три цели.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),ejs=require('ejs');
const pixel=require('../src/config/metaPixel');
const ID='1234567890123456',ORIGIN='https://xtender.ge';

// Идентификатор: переменная окружения важнее; на локальной копии — только заданный явно; мусор не принимается.
assert.equal(pixel.resolveId({}),'1012072607880558');
assert.equal(pixel.resolveId({META_PIXEL_ID:ID}),ID);
assert.equal(pixel.resolveId({META_PIXEL_ID:' '+ID+' ',NODE_ENV:'development'}),ID);
assert.equal(pixel.resolveId({NODE_ENV:'development'}),'');
assert.equal(pixel.resolveId({META_PIXEL_ID:''}),'');
for(const bad of ['G-RP7E07YTBH','12345','"><script>','1234567890abcdef']) assert.equal(pixel.resolveId({META_PIXEL_ID:bad}),'',bad);

// Открытые страницы получают пиксель; страницы с секретными ссылками в адресе, кабинеты и админка — нет.
for(const p of ['/','/ru','/en/','/join','/ru/join','/en/guides/request','/terms','/ru/privacy','/s/avejis-gadazidva','/en/s/tvirtis-gadazidva']) assert.equal(pixel.tagFor(p,ID).id,ID,p);
for(const p of ['/o/SECRET','/order/abc','/master','/master/tok','/review/tok','/my-orders','/z/tok','/admin','/manager/orders','/ru/o/x','/s/'])
  assert.equal(pixel.tagFor(p,ID),null,p);
assert.equal(pixel.tagFor('/',''),null);

// Каждый параметр адреса, который читают открытые страницы, отнесён к открытым или к закрытым.
const routes=fs.readFileSync(path.join(__dirname,'../src/routes/public.routes.js'),'utf8');
const known=[...pixel.PRIVATE_PARAMS,...pixel.OPEN_PARAMS];
for(const [,name] of routes.matchAll(/req\.query\.([A-Za-z_]+)/g)) assert.ok(known.includes(name),'параметр '+name+' не отнесён ни к одному списку в metaPixel.js');
assert.deepEqual(pixel.PRIVATE_PARAMS.filter(name=>pixel.OPEN_PARAMS.includes(name)),[]);

const views=path.join(__dirname,'../src/views'),view=f=>fs.readFileSync(path.join(views,f),'utf8');
const partial=path.join(views,'partials/meta-pixel.ejs'),render=locals=>ejs.render(view('partials/meta-pixel.ejs'),locals,{filename:partial});
const html=render({metaPixel:pixel.tagFor('/ru',ID)});
assert.match(html,/<script src="\/js\/meta-pixel\.js" data-id="1234567890123456" data-pages="[^"]+" data-private="ref,promo" defer><\/script>/);
assert.ok(!render({metaPixel:null}).includes('<script'));assert.ok(!render({}).includes('<script'),'шаблон без пикселя рендерится без скрипта');
// Пиксель подключается после google-tag: тот задаёт xtTrack, пиксель встаёт перед ним.
for(const f of ['partials/head.ejs','terms.ejs','privacy.ejs']){
  const text=view(f),google=text.search(/include\('(partials\/)?google-tag'\)/),meta=text.search(/include\('(partials\/)?meta-pixel'\)/);
  assert.ok(google!==-1&&meta>google,f);
}

// Скрипт страницы в подставном браузере. Атрибуты берутся из отрисованного шаблона.
const attrs={};for(const [,name,value] of html.matchAll(/ (data-[a-z]+)="([^"]*)"/g)) attrs[name]=value.replace(/&#(\d+);/g,(m,code)=>String.fromCharCode(code)).replace(/&amp;/g,'&');
const source=fs.readFileSync(path.join(__dirname,'../public/js/meta-pixel.js'),'utf8');
function browser({href=ORIGIN+'/ru',referrer='',staff=false,webdriver=false,id=ID,readyState='complete',pages=attrs['data-pages'],google=true,tab={}}={}){
  const url=new URL(href),scripts=[],listeners={},passed=[],window={addEventListener:(type,fn)=>{listeners[type]=fn;}};
  // google-tag.js на странице стоит раньше и уже задал xtTrack.
  if(google) window.xtTrack=(name,params,cb)=>{passed.push([name,params]);if(typeof cb==='function')cb();};
  const data={'data-id':id,'data-pages':pages,'data-private':attrs['data-private']};
  vm.runInContext(source,vm.createContext({window,URL,URLSearchParams,RegExp,
    location:{origin:url.origin,pathname:url.pathname,search:url.search},navigator:{webdriver},
    localStorage:{getItem:key=>(key==='xt_staff'&&staff?'1':null)},
    sessionStorage:{getItem:key=>tab[key]??null,setItem:(key,value)=>{tab[key]=String(value);}},
    document:{referrer,readyState,currentScript:{getAttribute:name=>data[name]??null},createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}}}));
  return {window,scripts,listeners,passed,sent:()=>Array.from(window.fbq?window.fbq.queue:[],args=>Array.from(args))};
}

// Обычный просмотр: автоматический сбор выключен до init, затем просмотр страницы; библиотека Meta одна.
let b=browser({href:ORIGIN+'/en/s/avejis-gadazidva?fbclid=abc&utm_source=facebook&utm_campaign=movers&campaign_id=77&lang=ka&city=batumi'});
assert.deepEqual(b.sent(),[['set','autoConfig',false,ID],['init',ID],['track','PageView']]);
assert.equal(b.scripts.length,1);assert.equal(b.scripts[0].src,'https://connect.facebook.net/en_US/fbevents.js');assert.equal(b.scripts[0].async,true);
// Библиотека Meta грузится после загрузки страницы.
b=browser({readyState:'loading'});assert.equal(b.scripts.length,0);b.listeners.load();assert.equal(b.scripts.length,1);
// Переход между открытыми страницами и с чужого сайта пиксель не выключает.
for(const referrer of ['https://l.facebook.com/l.php?u=x',ORIGIN+'/',ORIGIN,ORIGIN+'/en/s/avejis-gadazidva?fbclid=abc&utm_source=facebook',ORIGIN+'/ru/join'])
  assert.equal(browser({href:ORIGIN+'/s/avejis-gadazidva?lang=ka',referrer}).scripts.length,1,referrer);

// Пиксель не включается: ссылка менеджера или промокод в адресе; пришли со страницы заявки, кабинета или
// со страницы со ссылкой менеджера; сотрудник; робот; нет идентификатора; нет списка открытых страниц.
const off=[{href:ORIGIN+'/ru/join?ref=MANAGERTOKEN'},{href:ORIGIN+'/join?utm_source=facebook&promo=PROMOCODE'},{href:ORIGIN+'/o/SECRET-OWNER-LINK'},
  {referrer:ORIGIN+'/o/SECRET-OWNER-LINK'},{referrer:ORIGIN+'/order/tok?k=LEADKEY'},{referrer:ORIGIN+'/master/tok'},{referrer:ORIGIN+'/ru/join?ref=MANAGERTOKEN'},
  {staff:true},{webdriver:true},{id:''},{pages:null}];
for(const state of off){
  b=browser(state);let calls=0;
  assert.equal(b.window.fbq,undefined,JSON.stringify(state));assert.equal(b.scripts.length,0,JSON.stringify(state));
  // Страница при этом работает как раньше: событие идёт в google-tag, продолжение вызывается.
  b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{calls++;});assert.equal(calls,1);assert.equal(b.passed.length,1);
}

// Проверка из Events Manager: адрес с ?pixeltest=1 включает пиксель и у сотрудника, и на следующих
// страницах той же вкладки. Другое значение, другая вкладка и робот его не включают.
const tab={};
b=browser({href:ORIGIN+'/ru?pixeltest=1',staff:true,tab});assert.deepEqual(b.sent(),[['set','autoConfig',false,ID],['init',ID],['track','PageView']]);
b=browser({href:ORIGIN+'/ru/join',referrer:ORIGIN+'/ru?pixeltest=1',staff:true,tab});assert.equal(b.scripts.length,1,'та же вкладка, следующая страница');
b.window.xtTrack('sign_up',{method:'sms'});assert.deepEqual(b.sent().pop(),['track','CompleteRegistration']);
for(const state of [{href:ORIGIN+'/ru?pixeltest=0',staff:true},{href:ORIGIN+'/ru',staff:true,tab:{}},{href:ORIGIN+'/ru?pixeltest=1',webdriver:true},{href:ORIGIN+'/ru/join?pixeltest=1&ref=MANAGERTOKEN',staff:true}])
  assert.equal(browser(state).window.fbq,undefined,JSON.stringify(state));

// Три цели уходят в Meta под её названиями и без параметров; шаги формы — нет. Всё идёт дальше в google-tag.
b=browser();let done=0;
b.window.xtTrack('lead_form_start');b.window.xtTrack('lead_form_code_sent');b.window.xtTrack('catalog_contact_start');b.window.xtTrack('language_suggest_click',{language:'ka'});
b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{done++;});b.window.xtTrack('catalog_contact_open');b.window.xtTrack('sign_up',{method:'sms'},()=>{done++;});
assert.deepEqual(b.sent().slice(3),[['track','Lead'],['track','Contact'],['track','CompleteRegistration']]);
assert.deepEqual(b.passed.map(e=>e[0]),['lead_form_start','lead_form_code_sent','catalog_contact_start','language_suggest_click','generate_lead','catalog_contact_open','sign_up']);
assert.equal(done,2);
// Сбой в библиотеке Meta не мешает ни Google, ни переходу в заявку.
b.window.fbq=()=>{throw new Error('blocked');};done=0;
b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{done++;});assert.equal(done,1);assert.equal(b.passed.pop()[0],'generate_lead');
// Страница без Google Analytics: пиксель работает сам, продолжение вызывается.
b=browser({google:false});done=0;
b.window.xtTrack('generate_lead',{lead_type:'order'},()=>{done++;});b.window.xtTrack('lead_form_start');
assert.equal(done,1);assert.deepEqual(b.sent().slice(3),[['track','Lead']]);

// Страницы вызывают события, из которых пиксель берёт цели.
const home=view('index.ejs'),join=view('join.ejs');
for(const name of ['generate_lead','catalog_contact_open']) assert.ok(home.includes("'"+name+"'"),name);
assert.ok(join.includes("'sign_up'"));

// Политика конфиденциальности называет Meta на трёх языках, в данных и в получателях.
const legal=require('../src/config/legal-content');
for(const lang of ['ka','ru','en']){
  const text=JSON.stringify(legal.privacy.body[lang]);
  assert.ok(text.includes('Facebook')&&text.includes('Instagram'),lang);assert.ok(/\(([^()]*)Meta([^()]*)2\.2\)/.test(text),lang+': Meta в получателях');
}
console.log('PASS: Meta Pixel: public pages only, off on private links and after private pages, staff and robots skipped, three goals sent');
