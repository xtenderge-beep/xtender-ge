// Собственная аналитика посещаемости: тип страницы вместо адреса (токены не пишутся),
// источники, боты и сотрудники, суточный обезличенный посетитель, визиты и вкладка в админке.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const b=db.backup();try{return await fn(pool);}catch(e){b.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const sa=require('../src/services/siteAnalytics.service');
const PHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PC='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
(async()=>{
 // Адрес → тип страницы; секретные токены не сохраняются.
 for(const [p,page] of [['/','home'],['/ru','home'],['/en/join','join'],['/ru/guides/request','guide'],['/o/AbCdEf123','client_order'],
   ['/order/xyz?x=1','lead'],['/master/tok123','provider_cabinet'],['/master/tok/topups/5','provider_topup'],['/master','provider_login'],
   ['/i/tok','manager_link'],['/review/tok','review'],['/wp-admin','other'],['/terms/','terms']]) assert.equal(sa.classifyPage(p),page,p);
 // Источник: utm важнее реферера, внутренние переходы — не источник.
 assert.equal(sa.parseSource('https://www.google.com/search?q=x','', 'xtender.ge'),'Google');
 assert.equal(sa.parseSource('https://l.facebook.com/l.php','', 'xtender.ge'),'Facebook');
 assert.equal(sa.parseSource('https://xtender.ge/join','', 'xtender.ge'),null);
 assert.equal(sa.parseSource('','', 'xtender.ge'),null);
 assert.equal(sa.parseSource('https://google.com','FB_Ads', 'xtender.ge'),'fb_ads');
 assert.equal(sa.parseSource('https://forum.example.org/t/1','', 'xtender.ge'),'forum.example.org');
 assert.equal(sa.device(PHONE),'mobile');assert.equal(sa.device(PC),'desktop');assert.equal(sa.browser(PC),'Chrome');assert.equal(sa.browser(PHONE),'Safari');
 assert.equal(sa.isBot('Googlebot/2.1'),true);assert.equal(sa.isBot('HeadlessChrome'),true);assert.equal(sa.isBot(''),true);assert.equal(sa.isBot(PHONE),false);

 const base={host:'xtender.ge',country:'GE',lang:'ru',width:390};
 assert.equal(await sa.record({...base,path:'/ru',referrer:'https://www.google.com/',ip:'1.1.1.1',userAgent:PHONE}),true);
 assert.equal(await sa.record({...base,path:'/ru/join',referrer:'https://xtender.ge/ru',ip:'1.1.1.1',userAgent:PHONE}),true);
 assert.equal(await sa.record({...base,path:'/o/SECRET-TOKEN',referrer:'',ip:'2.2.2.2',userAgent:PC,country:'XX',width:1280}),true);
 assert.equal(await sa.record({...base,path:'/',referrer:'',ip:'3.3.3.3',userAgent:'Googlebot/2.1'}),false,'bots are skipped');
 assert.equal(await sa.record({...base,path:'/',referrer:'',ip:'4.4.4.4',userAgent:PC,staff:true,width:1280}),true);
 const rows=(await pool.query('SELECT * FROM site_visits ORDER BY id')).rows;
 assert.equal(rows.length,4);
 assert.ok(!JSON.stringify(rows).includes('SECRET-TOKEN'),'tokens never stored');
 assert.ok(!JSON.stringify(rows).includes('1.1.1.1'),'IP never stored');
 assert.equal(rows[0].visitor,rows[1].visitor,'same person same day = one visitor');
 assert.notEqual(rows[0].visitor,rows[2].visitor);
 assert.deepEqual(rows.map(r=>[r.page,r.source,r.device,r.country,r.is_staff]),[['home','Google','mobile','GE',false],['join',null,'mobile','GE',false],['client_order',null,'desktop',null,false],['home',null,'desktop','GE',true]]);
 // Соль дня живёт только в Redis — другой день, другой посетитель.
 const keys=await redis.keys('analytics_salt:*');assert.equal(keys.length,1);
 // Лимит на IP: не больше 120 записей в минуту.
 for(let i=0;i<125;i++) await sa.record({...base,path:'/',referrer:'',ip:'9.9.9.9',userAgent:PC,width:1280});
 assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM site_visits WHERE page='home' AND device='desktop' AND is_staff=false")).rows[0].n,120);
 await pool.query("DELETE FROM site_visits WHERE device='desktop' AND page='home' AND is_staff=false");

 // Визиты: пауза больше 30 минут начинает новый визит; отказ — визит из одной страницы.
 const t0=Date.parse('2026-10-01T08:00:00Z');
 const s=sa.summarize([{visitor:'a',page:'home',source:'Google',created_at:new Date(t0)},{visitor:'a',page:'join',created_at:new Date(t0+5*60000)},
   {visitor:'a',page:'home',created_at:new Date(t0+60*60000)},{visitor:'b',page:'home',created_at:new Date(t0)}]);
 assert.deepEqual([s.pageviews,s.visitors,s.visits,s.bounces],[4,2,3,2]);
 assert.deepEqual(s.visitList.map(v=>v.source),['Google','Прямой заход','Прямой заход']);

 // Отчёт за сегодня: сотрудники не считаются, есть «сейчас на сайте», конверсия на /join.
 const window=require('../src/services/dashboard.service').windowFor('today');
 const r=await sa.report(window);
 assert.deepEqual([r.current.pageviews,r.current.visitors,r.current.visits,r.online],[3,2,2,2]);
 assert.equal(r.joinVisitors,1);assert.equal(r.hourly,true);
 assert.deepEqual(r.sources.map(x=>[x.name,x.count]),[['Google',1],['Прямой заход',1]]);
 assert.equal(r.pages.find(p=>p.name==='client_order').label,'Страница заявки заказчика');

 // Вкладка рендерится, в том числе без данных.
 const ejs=require('ejs'),file=path.join(__dirname,'../src/views/admin/_traffic.ejs');
 const html=ejs.render(fs.readFileSync(file,'utf8'),{dashboard:{traffic:r,current:{confirmed:1}}},{filename:file});
 assert.match(html,/Посещаемость сайта/);assert.match(html,/Сейчас на сайте: <b>2<\/b>/);assert.match(html,/Google/);assert.match(html,/Телефон/);assert.match(html,/Грузия/);
 assert.match(html,/1 регистраций из 1 посетителей \/join|0 регистраций из 1 посетителей \/join/);
 await pool.query('DELETE FROM site_visits');
 const empty=ejs.render(fs.readFileSync(file,'utf8'),{dashboard:{traffic:await sa.report(window),current:{confirmed:0}}},{filename:file});
 assert.match(empty,/Данных пока нет/);
 // Скрипт счётчика подключён к публичным страницам, а метка сотрудника — к админке и кабинету менеджера.
 const view=f=>fs.readFileSync(path.join(__dirname,'../src/views',f),'utf8');
 for(const f of ['partials/head.ejs','terms.ejs','privacy.ejs']) assert.match(view(f),/\/js\/visit\.js/,f);
 for(const f of ['admin/_header.ejs','manager/_header.ejs']) assert.match(view(f),/xt_staff/,f);
 console.log('PASS: cookieless site analytics: page types, sources, bots, staff, daily visitors, visits and the admin tab');
})().catch(e=>{console.error(e);process.exit(1);});
