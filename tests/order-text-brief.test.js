// Правка заявки менеджером (переписать до рассылки, уточнить после) и карточка «Кратко» от ИИ:
// журнал правок, перевод, проверка ответа модели, показ исполнителям только с разрешения менеджера.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
stub('../src/services/sms.service',{sendOrderNotification:async()=>({ok:true,providerMessageId:'test'})});
const real=require('../src/services/translation.service');
stub('../src/services/translation.service',{detectLang:real.detectLang,translateOrder:async text=>({sourceLang:real.detectLang(text),translations:{ka:'KA: '+text,en:'EN: '+text}})});
const updated=[];stub('../src/services/telegram.service',{updateMessage:async order=>{updated.push(order.id);},sendToChat:async()=>{},sendLeadToMaster:async()=>false});
const orderText=require('../src/services/orderText.service'),briefs=require('../src/services/orderBrief.service'),orders=require('../src/services/order.service'),dispatch=require('../src/services/dispatch.service'),masters=require('../src/services/master.service');
const {translate,clientStrings}=require('../src/config/i18n'),{buildSeo}=require('../src/config/seo');
const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('background work did not finish');};
const events=async(orderId,type)=>(await pool.query('SELECT metadata FROM sms_consent_logs WHERE order_id=$1 AND event_type=$2 ORDER BY id',[orderId,type])).rows.map(r=>r.metadata);
const CLIENT='Нужно перевезти диван и холодильник из Сабуртало в Глдани';
(async()=>{
  const order=(await pool.query("INSERT INTO orders(token,owner_token,phone,description,district_name,status) VALUES('text-1','text-owner','+995500005111',$1,'Сабуртало','pending_review') RETURNING *",[CLIENT])).rows[0];
  const stored=()=>orders.getOrderByToken(order.token);

  // --- Карточка «Кратко»: ответу модели не доверяем.
  assert.equal(briefs.enabled(),false,'без ключа и без подставленной модели сервис выключен');
  assert.equal(await briefs.generate(order),null);assert.equal(await briefs.refresh(order.id),null);
  const answer={fields:{what:{ru:'Диван и холодильник',ka:'დივანი და მაცივარი',en:'Sofa and fridge'},from:{ru:'Сабуртало'},to:{ru:'  Глдани  ',en:'Gldani'},when:{ru:''},secret:{ru:'лишнее поле'},budget:'не объект',size:{ru:'x'.repeat(500)}},
    services:['transport','movers','no-such-service','flatbed'],sizes:['XL','M','HUGE','M'],missing:['этаж и лифт','','дата и время',5,'a','b','c','d'],questions:'Подскажите, пожалуйста, этаж и когда нужна перевозка?',shared:true};
  let prompts=[];briefs.useModel(async prompt=>{prompts.push(prompt);return 'Вот карточка:\n```json\n'+JSON.stringify(answer)+'\n```';});
  const brief=await briefs.refresh(order.id);
  assert.deepEqual(Object.keys(brief.fields),['what','from','to','size'],'только известные поля с текстом');
  assert.equal(brief.fields.to.ru,'Глдани');assert.equal(brief.fields.size.ru.length,200);
  assert.deepEqual([brief.services,brief.sizes],[['transport','movers'],['M','XL']],'только существующие услуги и классы; «бортовая» отдельно не предлагается');
  assert.deepEqual(brief.missing,['этаж и лифт','дата и время','a','b','c']);
  assert.equal(brief.shared,false,'показ исполнителям модель себе не включает');
  assert.match(prompts[0],/Use ONLY facts written in the request/);assert.ok(prompts[0].includes(CLIENT)&&prompts[0].includes('Сабуртало')&&prompts[0].includes('transport = '));
  assert.ok(!prompts[0].includes('+995500005111'),'телефон заказчика в запрос к модели не уходит');
  assert.deepEqual(briefs.lines(brief,'en').map(l=>[l.key,l.text]),[['what','Sofa and fridge'],['from','Сабуртало'],['to','Gldani'],['size','x'.repeat(200)]],'нет перевода поля — показывается имеющийся текст');
  assert.deepEqual(briefs.read(await stored()).fields.what,answer.fields.what);
  assert.equal(briefs.sanitize('не JSON',[]),null);assert.equal(briefs.sanitize('[1,2]',[]),null);assert.equal(briefs.sanitize('{"fields":',[]),null);
  // Текст изменили, пока модель думала, — устаревшая карточка не сохраняется.
  briefs.useModel(async()=>{await pool.query("UPDATE orders SET manager_note='срочно' WHERE id=$1",[order.id]);return JSON.stringify(answer);});
  assert.equal(await briefs.refresh(order.id),null);
  await pool.query('UPDATE orders SET manager_note=NULL WHERE id=$1',[order.id]);
  briefs.useModel(async()=>{throw new Error('timeout');});assert.equal(await briefs.refresh(order.id),null,'сбой модели ничего не ломает');
  briefs.useModel(async prompt=>{prompts.push(prompt);return JSON.stringify(answer);});

  // --- Показ исполнителям: только после разрешения менеджера.
  assert.equal(await briefs.setShared(order.token,true),true);assert.equal(briefs.read(await stored()).shared,true);
  assert.equal(await briefs.setShared('no-such-order',true),false);

  // --- Менеджер переписал текст до рассылки: текст заказчика сохранён, правка в журнале, карточка собрана заново.
  await assert.rejects(()=>orderText.edit(order.token,'коротко','manager:7'),/от 10 до 5000/);
  await assert.rejects(()=>orderText.edit('no-such-order','Достаточно длинный текст','manager:7'),{status:404});
  const EDITED='Перевезти диван 2,2 м и холодильник из Сабуртало в Глдани, 3 этаж без лифта';
  prompts=[];updated.length=0;
  const edited=await orderText.edit(order.token,'  '+EDITED+'  ','manager:7',{ip:'10.0.0.1'});
  assert.deepEqual([edited.description,edited.client_description,edited.source_lang,edited.brief],[EDITED,CLIENT,'ru',null]);
  assert.deepEqual(await events(order.id,'ORDER_EDITED_BY_MANAGER'),[{before:CLIENT,after:EDITED,actor:'manager:7'}]);
  await until(async()=>briefs.read(await stored()));
  let now=await stored();
  assert.deepEqual(now.description_translations,{ka:'KA: '+EDITED,en:'EN: '+EDITED});
  assert.equal(briefs.read(now).shared,false,'после правки карточку надо проверить заново');
  assert.ok(prompts[0].includes(EDITED));assert.deepEqual(updated,[order.id],'сообщение модераторам обновлено');
  assert.equal(await orderText.edit(order.token,EDITED,'manager:7'),null,'тот же текст — не правка');
  await orderText.edit(order.token,EDITED+'.','manager:8');
  assert.equal((await stored()).client_description,CLIENT,'исходный текст заказчика остаётся первым');
  assert.equal((await events(order.id,'ORDER_EDITED_BY_MANAGER')).length,2);

  // --- Уточнение отдельным блоком: текст не меняется, перевод и журнал есть.
  const NOTE='Клиент уточнил: после 18:00, лифта нет';
  await until(async()=>briefs.read(await stored()));prompts=[];
  const clarified=await orderText.clarify(order.token,NOTE,'manager:7');
  assert.deepEqual([clarified.manager_note,clarified.description,clarified.brief],[NOTE,EDITED+'.',null]);
  assert.deepEqual(await events(order.id,'ORDER_CLARIFIED_BY_MANAGER'),[{before:'',after:NOTE,actor:'manager:7'}]);
  await until(async()=>briefs.read(await stored())&&(await stored()).manager_note_translations.source);
  now=await stored();
  assert.deepEqual(orderText.noteTexts(now),{ru:NOTE,ka:'KA: '+NOTE,en:'EN: '+NOTE});
  assert.ok(prompts.some(prompt=>prompt.includes("Manager's clarification:\n"+NOTE)),'уточнение входит в запрос карточки');
  await assert.rejects(()=>orderText.clarify(order.token,'x'.repeat(2001),'manager:7'),/до 2000/);
  assert.equal(await orderText.clarify(order.token,NOTE,'manager:7'),null);
  assert.deepEqual(orderText.noteTexts({manager_note:'только что сохранено',manager_note_translations:{}}),{ru:'только что сохранено'},'до прихода перевода показывается исходный текст');
  assert.deepEqual(orderText.noteTexts({manager_note:null}),{});

  // --- Экран менеджера: связь с заказчиком и карточка.
  const screen=await dispatch.screen(order.token);
  assert.equal(screen.canEditText,true);assert.equal(screen.briefEnabled,true);
  assert.deepEqual(screen.briefLines.slice(0,2),[{key:'what',text:'Диван и холодильник'},{key:'from',text:'Сабуртало'}]);
  assert.deepEqual(screen.briefServices.map(s=>s.key),['transport','movers']);
  assert.equal(decodeURIComponent(screen.whatsappUrl),'https://wa.me/995500005111?text=Здравствуйте! Это Xtender. Уточняем вашу заявку №'+order.id+'. Подскажите, пожалуйста, этаж и когда нужна перевозка?');
  assert.equal((await dispatch.screen((await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('text-ka','+995 500 005 222','მჭირდება ევაკუატორი ვაკეში დღეს საღამოს','pending_review') RETURNING token")).rows[0].token)).whatsappUrl.startsWith('https://wa.me/995500005222?text='+encodeURIComponent('გამარჯობა!')),true,'приветствие на языке заявки');

  // --- Отправка одной кнопкой записывает решение менеджера о карточке; после рассылки текст не переписать.
  const m=await masters.registerMaster({name:'Фургон',phone:'+995500005333',serviceType:null});
  await masters.updateMasterProfile(m.id,{name:m.name,phone:m.phone,services:[{type:'van',attributes:{body:'closed'}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[m.id]);await require('./billing-fixture')(pool,m.id);
  await dispatch.sendNeeds(order.token,{needs:['transport']},null,'',{actor:'manager:7',shareBrief:true});
  now=await stored();
  assert.equal(briefs.read(now).shared,true);assert.ok(now.first_dispatched_at);
  await assert.rejects(()=>orderText.edit(order.token,'Совсем другой текст заявки после рассылки','manager:7'),{status:409});
  assert.equal((await dispatch.screen(order.token)).canEditText,false);
  await orderText.clarify(order.token,'','manager:7');
  assert.equal((await stored()).manager_note,null,'пустое уточнение убирает блок');
  await orderText.clarify(order.token,'Добавили: нужен скотч и плёнка','manager:9');
  await until(async()=>briefs.read(await stored()));
  assert.equal(briefs.read(await stored()).shared,false,'после уточнения карточка снова ждёт проверки');
  await pool.query("UPDATE orders SET status='closed' WHERE id=$1",[order.id]);
  await assert.rejects(()=>orderText.clarify(order.token,'поздно','manager:7'),{status:409});
  await pool.query("UPDATE orders SET status='new' WHERE id=$1",[order.id]);

  // --- Страница заявки: карточка только с разрешения, уточнение видят и исполнитель, и заказчик.
  const page=async(lang,locals)=>ejs.renderFile(path.join(__dirname,'../src/views/order.ejs'),{
    lang,t:translate(lang),clientStrings:clientStrings(lang),currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(lang,'/'),
    order:await stored(),files:[],isOwner:false,masterId:m.id,masterCategory:'transport',funnel:null,masterAccount:null,targetCategories:['transport'],closedCategories:[],
    categoryLabels:{},whatsappText:'x',createdMinutesAgo:1,revisionCopy:{title:''},revisionCsrf:'x',requestLang:'ru',langAdvice:false,
    noteTexts:orderText.noteTexts(await stored()),briefCard:null,...locals});
  const savedBrief=briefs.read(await stored()),card=Object.fromEntries(['ka','ru','en'].map(lang=>[lang,briefs.lines(savedBrief,lang)]));
  const hidden=await page('ru',{});
  assert.ok(!hidden.includes('Диван и холодильник'),'карточку без разрешения менеджера исполнитель не видит');
  assert.match(hidden,/Уточнение от Xtender/);assert.match(hidden,/Добавили: нужен скотч и плёнка/);
  const shown=await page('en',{briefCard:card});
  assert.match(shown,/In short/);assert.match(shown,/<span class="font-bold">What:<\/span> Sofa and fridge/);
  assert.match(shown,/Compiled automatically from the request text\. Full text below\./);
  assert.match(shown,/Clarification from Xtender/);assert.match(shown,/EN: Добавили: нужен скотч и плёнка/);
  const georgian=await page('ka',{briefCard:card});
  assert.match(georgian,/მოკლედ/);assert.match(georgian,/დაზუსტება Xtender-ისგან/);
  const owner=await page('ru',{isOwner:true,masterId:null,briefCard:card});
  assert.ok(!owner.includes('Диван и холодильник'),'заказчику карточка не показывается');
  assert.match(owner,/Добавили: нужен скотч и плёнка/);
  const editedNotice=/<div class="mt-1 text-xs text-stone-500">Текст уточнил менеджер Xtender после разговора с вами\.<\/div>/;
  assert.match(owner,editedNotice,'заказчик видит, что текст поправил менеджер');
  assert.doesNotMatch(hidden,editedNotice,'исполнителю эта пометка не нужна');
  // Страница заказчика: что дальше, счётчики словами, без буквы класса кузова, своя подсказка о закрытии.
  await pool.query("UPDATE orders SET requirements='{\"configured\":true,\"transport_size\":\"M\",\"transport_sizes\":[\"M\"]}'::jsonb WHERE id=$1",[order.id]);
  const labels={transport:'Перевозки'},funnel={view:5,call:1,whatsapp:2};
  const sentPage=await page('ru',{isOwner:true,masterId:null,funnel,recipientsCount:8,categoryLabels:labels});
  assert.match(sentPage,/Заявку получили исполнители: 8\. Заинтересованные позвонят или напишут вам сами\./);
  assert.match(sentPage,/<\/i>Открыли заявку: 5<\/span>/);assert.match(sentPage,/<\/i>Нажали «Позвонить»: 1<\/span>/);assert.match(sentPage,/<\/i>Нажали «WhatsApp»: 2<\/span>/);
  assert.match(sentPage,/<span>Перевозки<\/span>/,'буквы класса кузова заказчик не видит');
  assert.match(await page('ru',{categoryLabels:labels}),/<span>Перевозки · M<\/span>/,'исполнитель букву видит');
  assert.match(sentPage,/<p class="mb-3 text-sm text-stone-600">Нашли исполнителя или услуга больше не нужна\? Закройте заявку, и новые исполнители её не получат\./);
  assert.ok(!sentPage.includes('>'+translate('ru')('consent_closing')+'<'),'фразы «откройте заявку по ссылке из SMS» на самой заявке больше нет');
  // Тексты страницы лежат и в её скрытом словаре, поэтому проверяем сам блок, а не наличие строки.
  assert.doesNotMatch(await page('ru',{isOwner:true,masterId:null,funnel,recipientsCount:0,categoryLabels:labels}),/font-medium">Заявку получили исполнители/,'без получателей строки нет');
  const fresh={...(await stored()),status:'pending_review',first_dispatched_at:null};
  const freshPage=await page('ru',{isOwner:true,masterId:null,order:fresh,funnel:{view:0,call:0,whatsapp:0},recipientsCount:0});
  assert.match(freshPage,/font-medium">Заявка на проверке у менеджера\. После проверки её получат подходящие исполнители\.<\/div>/);
  assert.doesNotMatch(freshPage,/Открыли заявку: 0/,'до рассылки счётчики откликов не показываются');
  assert.doesNotMatch(await page('ru',{order:fresh}),/font-medium">Заявка на проверке у менеджера/,'строка «что дальше» только для заказчика');
  for(const lang of ['ka','ru','en'])for(const key of ['order_note_title','order_text_edited','order_next_review','order_next_sent','order_funnel_view','order_funnel_call','order_funnel_whatsapp','order_close_hint','order_brief_title','order_brief_auto',...briefs.FIELDS.map(f=>'order_brief_'+f)])assert.notEqual(translate(lang)(key),key,lang+' '+key);
  // --- Настоящий вызов модели (OpenRouter подменён): JSON запрашивается через response_format, а если
  // провайдер его не принимает (400) — повтор без него; ключ уходит в заголовке, телефон не уходит.
  const calls=[];let refuseFormat=true;
  stub('axios',{post:async(url,body,options)=>{calls.push({url,body,options});
    if(body.response_format&&refuseFormat)throw Object.assign(new Error('Bad Request'),{response:{status:400}});
    return {data:{choices:[{message:{content:JSON.stringify(answer)}}]}};}});
  delete require.cache[require.resolve('../src/services/orderBrief.service')];process.env.OPENROUTER_API_KEY='test-key';
  const live=require('../src/services/orderBrief.service');
  assert.equal(live.enabled(),true);
  const made=await live.generate(await stored());
  assert.deepEqual(made.fields.what,answer.fields.what);
  assert.deepEqual(calls.map(c=>Boolean(c.body.response_format)),[true,false],'повтор без response_format после отказа');
  assert.equal(calls[0].url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(calls[0].options.headers.Authorization,'Bearer test-key');
  assert.ok(calls[0].body.max_tokens>=3000);assert.ok(!JSON.stringify(calls[0].body).includes('+995500005111'));
  refuseFormat=false;calls.length=0;await live.generate(await stored());assert.equal(calls.length,1);
  stub('axios',{post:async()=>{throw Object.assign(new Error('Server error'),{response:{status:500}});}});
  delete require.cache[require.resolve('../src/services/orderBrief.service')];
  assert.equal(await require('../src/services/orderBrief.service').refresh(order.id),null,'ошибка сервиса не бросается наружу');
  console.log('PASS: manager edit before dispatch, clarification after, audit log, translations, AI card sanitised and shared only by the manager, order page');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
