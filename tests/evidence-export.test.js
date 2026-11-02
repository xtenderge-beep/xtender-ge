// Архив доказательств по номеру: сценарий из согласованного плана. Исполнитель регистрируется кодом с обеими
// отметками, получает SMS о заявках, выключает предложения, администратор меняет ему номер, на новом номере нажимают
// Stop, он снова включает заявки, встаёт на паузу и снимает её кодом; оферта после регистрации меняется; на старый
// номер оформляет заявку заказчик; есть исполнитель без записей. Проверяется: профили не объединяются, документы в
// редакции на момент принятия, «принято» отдельно от «доставлено», секретов в архиве нет, отсутствующее перечислено,
// целостность проверяется скриптом из архива и ловит правку, выгрузка только по коду и записывается в журнал.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{spawnSync}=require('child_process');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
const redis=new(require('ioredis-mock'))();
stub('../src/config/db',pool);stub('../src/config/redis',redis);
const sms=[];let gw=0;
stub('../src/services/sms.service',{
  sendOrderNotification:async(phone,text,context)=>{sms.push({phone,text,kind:context?.kind});const id='gw-'+(++gw);
    await require('../src/services/consentLog.service').recordSmsDelivery({phone,kind:context?.kind,body:text,category:context?.category,masterId:context?.masterId,orderId:context?.orderId,providerMessageId:id});
    return {ok:true,providerMessageId:id,messageBody:text};},
  sendOtp:async(phone,code)=>{sms.push({phone,text:'Code: '+code,kind:'otp'});return {ok:true,providerMessageId:'gw-'+(++gw),messageBody:'Xtender code: '+code};},
});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
const alerts=[];
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{},notifyModeratorNewMaster:async()=>{},sendSecurityAlert:async(text)=>{alerts.push(text);}});
// Метка времени без сети: ответ-заглушка; настоящая служба проверяется отдельно на копии рабочей базы.
let tsaCalls=0;
stub('../src/services/evidence/tsa',{stamp:async(hash)=>{tsaCalls+=1;return {url:'https://tsa.test',genTime:new Date(),granted:true,imprintMatches:true,nonceMatches:true,response:Buffer.from('tsr:'+hash).toString('base64')};}});
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service');
const consent=require('../src/services/consent.service'),otp=require('../src/services/otp.service'),consentLog=require('../src/services/consentLog.service');
const permissions=require('../src/services/smsPermissions.service'),pause=require('../src/services/leadPause.service');
const cabinet=require('../src/controllers/master.controller'),stopPage=require('../src/controllers/leadStop.controller');
const legal=require('../src/services/legalContent.service'),settings=require('../src/services/settings.service');
const subjects=require('../src/services/evidence/subject'),builder=require('../src/services/evidence/build'),zip=require('../src/services/evidence/zip');
const evidence=require('../src/services/evidence');
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},set(){return this;},render(view,data){this.view=view;this.data=data;}});
const request=extra=>({params:{},query:{},body:{},headers:{'x-forwarded-for':'203.0.113.10, 10.0.0.1'},lang:'ru',ip:'10.0.0.1',get:()=> 'phone-browser',cookies:{},...extra});
const row=async id=>(await pool.query('SELECT * FROM masters WHERE id=$1',[id])).rows[0];
let seq=0,orderSeq=0;
async function provider(name,extra={}) {
  const m=await masters.registerMaster({name,phone:'+99559900'+String(++seq).padStart(4,'0'),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  if(extra.telegram) await pool.query('UPDATE masters SET telegram_id=$2 WHERE id=$1',[m.id,extra.telegram]);
  return row(m.id);
}
const newOrder=(phone='+995500009999')=>pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,$3,'Перенести шкаф','pending_review',$4) RETURNING *",['ordtok'+crypto.randomBytes(5).toString('hex'),'own-'+(++orderSeq),phone,[]]).then(r=>r.rows[0]);
const send=async()=>{const order=await newOrder();await dispatch.sendNeeds(order.token,{needs:['movers']},null,'',{actor:'test'});return order;};
const unpack=archive=>{const files=zip.read(archive);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xt-evidence-'));for(const[name,data]of files){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),data);}return {files,dir};};
const text=files=>[...files.values()].map(b=>b.toString('utf8')).join('\n');
const runVerify=dir=>spawnSync(process.execPath,[path.join(dir,'verify.js')],{encoding:'utf8'});

(async()=>{
  // --- Сценарий ---
  // Оферта на момент регистрации — та, что в коде; позже администратор её меняет.
  const termsAtSignup=await legal.getTerms();
  const base={consentLanguage:'ru',consentDigest:(await consent.bundle('provider','ru')).digest,termsAccepted:true,privacyAccepted:true,leadSmsAccepted:true,marketingSmsAccepted:true};
  const oldPhone='+995599001111',newPhone='+995599002222';
  const consentForCode=(await consent.acceptedRequest({body:base},'provider')).consent;
  const sent=await otp.sendCode(oldPhone,'master',null,{consent:consentForCode,meta:{ip:'203.0.113.10',userAgent:'phone-browser',xForwardedFor:'203.0.113.10, 10.0.0.1'}});
  const signupCode=await redis.get('otp:master:'+oldPhone);
  assert.equal(await otp.verifyCode(oldPhone,signupCode,'master',{challengeId:sent.challengeId,strict:true,meta:{ip:'203.0.113.10',userAgent:'phone-browser'}}),true);
  const grant=await otp.getConsentGrant(oldPhone,'master',sent.challengeId);
  let a=await masters.registerMaster({createOnly:true,name:'Гиорги',phone:oldPhone,serviceType:null,consentGrant:grant,requestMeta:{ip:'203.0.113.10'},cityIds:[1],cityId:1,spokenLanguages:['ru']});
  await permissions.applyRegistration(a.id,oldPhone,grant,{ip:'203.0.113.10'});
  await masters.updateMasterProfile(a.id,{name:'Гиорги',phone:oldPhone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(a.id);
  a=await row(a.id);
  const other=await provider('Леван');
  // Две SMS о заявках, одну он открывает.
  const o1=await send(),o2=await send();
  await pool.query("INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,'view')",[o1.id,a.id]);
  // Предложения выключает в кабинете.
  let res=response();await cabinet.setMarketing(request({params:{token:a.master_token},body:{subscribed:false}}),res);
  assert.equal(res.data.success,true);
  // Администратор меняет номер, кодом новый номер не подтверждён.
  await masters.updateMasterProfile(a.id,{name:'Гиорги',phone:newPhone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru'],changedBy:'admin',meta:{ip:'198.51.100.99',userAgent:'admin-laptop',xForwardedFor:'198.51.100.99, 10.0.0.1'}});
  // На новый номер приходит заявка, держатель номера нажимает Stop.
  await send();
  const stopText=sms.filter(s=>s.kind==='lead'&&s.phone===newPhone).at(-1).text;
  const stopCode=stopText.match(/\/stop\/([A-Za-z0-9_-]+)$/)[1];
  res=response();await stopPage.stop(request({params:{code:stopCode},body:{action:'stop'},headers:{'x-forwarded-for':'192.0.2.77, 10.0.0.1'}}),res);
  assert.equal((await row(a.id)).is_subscribed,false);
  // Сам исполнитель снова включает заявки в кабинете (с текстом).
  res=response();await cabinet.setLeadSubscription(request({params:{token:a.master_token},body:{subscribed:true}}),res);
  assert.equal((await row(a.id)).is_subscribed,true);
  // Пауза: две неоткрытые заявки, которые открыл другой, затем снятие кодом.
  await settings.setSetting(pause.SINCE_KEY,'2020-01-01T00:00:00.000Z');
  await pool.query("DELETE FROM dispatch_deliveries WHERE master_id=$1",[a.id]);
  const p1=await send(),p2=await send();
  await pool.query("UPDATE dispatch_deliveries SET finished_at=$1",[new Date(Date.now()-3*3600*1000)]);
  for(const o of [p1,p2]) await pool.query("INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,'view')",[o.id,other.id]);
  await send();
  assert.ok((await row(a.id)).lead_sms_paused_at,'пауза поставлена');
  res=response();await cabinet.sendResumeCode(request({params:{token:a.master_token}}),res);
  res=response();await cabinet.verifyResumeCode(request({params:{token:a.master_token},body:{code:await redis.get('otp:lead_resume:'+newPhone)}}),res);
  assert.deepEqual(res.data,{success:true,resumed:true});
  // Одна SMS не принята шлюзом; для одной SMS пришёл отчёт о доставке.
  await consentLog.recordSmsDelivery({phone:newPhone,kind:'transactional',body:'Xtender: balance',category:'balance',masterId:a.id,status:'failed'});
  // Старый формат: телефон заказчика в тексте сообщения исполнителю.
  await consentLog.recordSmsDelivery({phone:newPhone,kind:'transactional',body:'Xtender: klienti +995 500 00 99 99',category:'service',masterId:a.id,providerMessageId:'gw-client'});
  const delivered=(await pool.query("SELECT otp_reference_id FROM sms_consent_logs WHERE event_type='LEAD_SMS_SENT' AND master_id=$1 ORDER BY id LIMIT 1",[a.id])).rows[0].otp_reference_id;
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,master_id,otp_reference_id,channel,metadata) VALUES('SMS_DELIVERY_REPORT',$1,$2,$3,'sms',$4)",[oldPhone,a.id,delivered,JSON.stringify({delivery_status:'delivered'})]);
  // Администратор меняет оферту после регистрации.
  const newTerms=await legal.saveTerms({ka:'ახალი ტექსტი 2.0',ru:'НОВАЯ РЕДАКЦИЯ ОФЕРТЫ 2.0',en:'New terms 2.0'});
  assert.notEqual(newTerms.version,termsAtSignup.version);
  // На старый номер Гиорги заявку оформляет заказчик; контакт уходит исполнителю Левану.
  const clientOrder=await newOrder(oldPhone);
  await consentLog.recordAction({eventType:'ORDER_PUBLISHED',phone:oldPhone,orderId:clientOrder.id,metadata:{consent_log_id:null},meta:{ip:'203.0.113.50'}});
  await consentLog.recordAction({eventType:'ORDER_DETAILS_RECORDED',phone:oldPhone,orderId:clientOrder.id,metadata:{description:'Перенести шкаф https://xtender.ge/order/'+clientOrder.token+'?k=secretkey1'}});
  await consentLog.recordAction({eventType:'ORDER_CONTACT_RELEASED',phone:oldPhone,orderId:clientOrder.id,masterId:other.id,metadata:{reason:'call'}});
  // Исполнитель без записей в журнале (заведён до журнала).
  const legacy=(await pool.query("INSERT INTO masters(name,phone,master_token,is_active) VALUES('Старый','+995599003333','legacytoken1',true) RETURNING *")).rows[0];

  // --- 1. Поиск: профили не объединяются, периоды и связь показаны ---
  const byOld=await subjects.search(oldPhone);
  assert.deepEqual(byOld.profiles.map(p=>p.id),[a.id],'по старому номеру — профиль Гиорги');
  assert.ok(byOld.profiles[0].usage[0].to,'период старого номера закончен');
  assert.ok(byOld.phoneOnly.orders>=1 && byOld.phoneOnly.records>=3,'заказчик на старом номере — отдельно');
  assert.ok(byOld.notes.some(n=>/не доказывает/.test(n)),'явно сказано, что связь не доказана');
  const byNew=await subjects.search('599 00 22 22');
  assert.deepEqual(byNew.profiles.map(p=>p.id),[a.id]);
  const periods=byNew.profiles[0].periods;
  assert.equal(periods.length,2);
  assert.match(periods[0].how,/регистрация с кодом из SMS/);
  assert.match(periods[1].how,/администратор/);
  assert.match(periods[1].how,/подтверждён кодом из SMS/,'новый номер позже подтверждён кодом снятия паузы');
  assert.deepEqual((await subjects.search('#'+legacy.id)).profiles.map(p=>p.id),[legacy.id]);

  // --- 2. Архив профиля для регулятора ---
  const built=await builder.build({subject:{type:'profile',id:a.id},purpose:'regulator',reason:'Тестовая жалоба',exportId:'test0000001',settleMs:-1000});
  const {files,dir}=unpack(built.archive);
  if(process.env.EVIDENCE_DUMP) fs.writeFileSync(process.env.EVIDENCE_DUMP,built.archive);
  const all=text(files);
  const manifest=JSON.parse(files.get('manifest.json'));
  assert.deepEqual(manifest.subject,{type:'profile',id:a.id});
  const records=JSON.parse(files.get('data/journal-records.json')).records;
  assert.ok(records.every(r=>r.row.master_id==a.id||r.linked_by!=='запись по номеру'),'в архиве профиля только его записи и доказуемо связанные');
  assert.ok(records.some(r=>r.event==='CONSENT_SMS_OTP_VERIFIED'&&/MASTER_REGISTERED/.test(r.linked_by)));
  assert.ok(records.some(r=>r.event==='SMS_OTP_SENT'&&/номер сообщения шлюза/.test(r.linked_by)));
  assert.ok(!records.some(r=>r.event==='ORDER_PUBLISHED'),'заявка заказчика на старом номере не попала в архив исполнителя');
  for (const type of ['LEAD_SMS_OPT_IN','MARKETING_SMS_OPT_IN','MARKETING_SMS_OPT_OUT','PHONE_CHANGED','PHONE_REPLACED','LEAD_SMS_OPT_OUT','LEAD_SMS_PAUSED','LEAD_RESUME_OTP_VERIFIED','LEAD_SMS_RESUMED','LEAD_SMS_SENT','SMS_SEND_FAILED'])
    assert.ok(records.some(r=>r.event===type),type);
  const times=records.map(r=>r.log_id);assert.deepEqual(times,[...times].sort((x,y)=>x-y),'по порядку журнала');
  // Документы: редакция на момент принятия, не нынешняя.
  const docs=JSON.parse(files.get('data/3-documents.json'));
  const termsFile=docs.flatMap(d=>d.documents).find(d=>d.kind==='terms');
  assert.equal(termsFile.version,termsAtSignup.version);
  assert.ok(!files.get(termsFile.file).toString().includes('НОВАЯ РЕДАКЦИЯ'),'нынешняя редакция не подставлена');
  assert.ok(files.get(termsFile.file).toString().includes('1.1. Общие положения'));
  const shown=docs.flatMap(d=>d.documents).filter(d=>d.kind==='shown_text').map(d=>files.get(d.file).toString());
  assert.ok(shown.some(t=>t.includes('Присылать мне заявки по SMS')),'текст согласия на заявки, как был показан');
  // Сообщения: «принято» отдельно от «доставлено».
  const smsItems=JSON.parse(files.get('data/5-sms.json'));
  assert.ok(smsItems.some(i=>i.gateway.code==='rejected'),'отклонённая шлюзом');
  assert.ok(smsItems.filter(i=>i.delivery.code==='delivered').length>=1,'есть доставленное по отчёту');
  assert.ok(smsItems.filter(i=>i.delivery.code==='delivered').every(i=>i.gateway_message_id===delivered),'доставлено только у записей сообщения с отчётом');
  assert.ok(smsItems.filter(i=>i.gateway.code==='accepted').every(i=>i.delivery.code!=='delivered'||i.gateway_message_id===delivered));
  assert.ok(smsItems.some(i=>i.delivery.code==='unknown'&&/только о приёме/.test(i.delivery.ru)));
  // Периоды номера в архиве.
  const subjectSection=JSON.parse(files.get('data/1-subject.json'));
  assert.equal(subjectSection.phone_periods.length,2);
  // Секретов нет.
  const tokens=[a.master_token,...(await pool.query('SELECT token FROM orders')).rows.map(r=>r.token),...(await pool.query('SELECT code FROM lead_stop_codes')).rows.map(r=>r.code),'secretkey1',signupCode+' '];
  for (const secret of tokens) assert.ok(!all.includes(secret),'секрет в архиве: '+secret);
  assert.ok(!/[?&]k=(?!\[скрыто\])/.test(all),'ключ доступа ?k=');
  assert.ok(!all.includes('198.51.100.99'),'IP администратора');
  assert.ok(!all.includes('admin-laptop'),'устройство администратора');
  assert.ok(!all.includes('+995500009999')&&!all.includes('500009999')&&!all.includes('500 00 99 99'),'телефон заказчика из заявок исполнителя');
  assert.ok(all.includes('klienti ••• 999'),'чужой номер в тексте заменён');
  assert.ok(!all.includes(other.phone)&&!all.includes(other.phone.slice(-9)),'телефон другого исполнителя');
  assert.ok(!all.includes('Перенести шкаф'),'текст чужой заявки');
  assert.ok(all.includes('192.0.2.77'),'для регулятора IP держателя номера при Stop виден');
  // Чего нет.
  const missing=JSON.parse(files.get('missing.json')).map(m=>m.code);
  for (const code of ['journal_start','delivery','chain_start']) assert.ok(missing.includes(code),code);
  // Целостность: всё проверено при выгрузке, скрипт из архива проходит, правка байта ловится.
  assert.ok(records.every(r=>r.verified_by_xtender_at_export===true),'все записи сверены с цепочкой');
  assert.ok(records.some(r=>r.independently_verifiable)&&records.some(r=>!r.independently_verifiable));
  const checks=JSON.parse(files.get('integrity.json')).checks_performed;
  assert.ok(checks.some(c=>c.performed===false&&/Подпись службы/.test(c.check)),'указано, что подпись службы не проверялась');
  assert.ok(checks.some(c=>/всей цепочки/.test(c.check)&&/цела/.test(c.result)));
  assert.ok(files.has('summary.html')&&files.get('summary.html').toString().includes('ქრონოლოგია'));
  assert.ok([...files.keys()].some(n=>/^anchors\/anchor-\d+\.tsr$/.test(n)),'метка времени отпечатка выгрузки в архиве');
  let check=runVerify(dir);
  assert.equal(check.status,0,check.stdout+check.stderr);
  const victim=path.join(dir,'data/5-sms.json');fs.writeFileSync(victim,fs.readFileSync(victim,'utf8').replace('"sms"','"SMS"'));
  check=runVerify(dir);
  assert.equal(check.status,1,'правка файла обнаружена');
  // Подменённая запись в выданной копии (при целом integrity.json) тоже ловится пересчётом отпечатка.
  const second=unpack(built.archive);
  const recPath=path.join(second.dir,'data/journal-records.json');
  const recJson=JSON.parse(fs.readFileSync(recPath,'utf8'));const target=recJson.records.find(r=>r.independently_verifiable);target.row.ip_address='1.2.3.4';
  fs.writeFileSync(recPath,JSON.stringify(recJson,null,2));
  const integ=JSON.parse(fs.readFileSync(path.join(second.dir,'integrity.json'),'utf8'));integ.files['data/journal-records.json']=crypto.createHash('sha256').update(fs.readFileSync(recPath)).digest('hex');
  fs.writeFileSync(path.join(second.dir,'integrity.json'),JSON.stringify(integ));
  check=runVerify(second.dir);
  assert.equal(check.status,1);assert.match(check.stdout,/не даёт записанный отпечаток/);

  // --- 3. Тот же профиль по запросу самого человека: IP держателя номера при Stop скрыт ---
  const forSubject=unpack((await builder.build({subject:{type:'profile',id:a.id},purpose:'subject',reason:'Запрос по ст. 14',exportId:'test0000002',settleMs:-1000})).archive);
  const subjectText=text(forSubject.files);
  assert.ok(!subjectText.includes('192.0.2.77'));
  assert.equal(runVerify(forSubject.dir).status,0);

  // --- 4. Архив по номеру: заказчик на старом номере, без записей профиля ---
  const phoneArchive=unpack((await builder.build({subject:{type:'phone',phone:oldPhone},purpose:'complaint',reason:'Жалоба заказчика',exportId:'test0000003',settleMs:-1000})).archive);
  const phoneRecords=JSON.parse(phoneArchive.files.get('data/journal-records.json')).records;
  assert.ok(phoneRecords.some(r=>r.event==='ORDER_PUBLISHED')&&phoneRecords.some(r=>r.event==='ORDER_CONTACT_RELEASED'));
  assert.ok(!phoneRecords.some(r=>['LEAD_SMS_SENT','PHONE_REPLACED','CONSENT_SMS_OTP_VERIFIED','MASTER_REGISTERED'].includes(r.event)),'записи профиля не попали в архив номера');
  const phoneSubject=JSON.parse(phoneArchive.files.get('data/1-subject.json'));
  assert.equal(phoneSubject.other_profiles_on_this_phone[0].profile_id,a.id);
  assert.match(phoneSubject.other_profiles_on_this_phone[0].note,/не доказывает/);
  const phoneText=text(phoneArchive.files);
  assert.ok(!phoneText.includes(clientOrder.token)&&!phoneText.includes('secretkey1'));
  assert.ok(phoneText.includes('Перенести шкаф'),'своя заявка заказчика в его архиве есть');
  assert.ok(!phoneText.includes(other.phone.slice(-9)),'телефон исполнителя, получившего контакт, не раскрыт');

  // --- 5. Исполнитель без записей: ничего не выдумано ---
  const legacyArchive=unpack((await builder.build({subject:{type:'profile',id:legacy.id},purpose:'regulator',reason:'Проверка старого профиля',exportId:'test0000004',settleMs:-1000})).archive);
  assert.equal(JSON.parse(legacyArchive.files.get('data/journal-records.json')).records.length,0);
  assert.ok(JSON.parse(legacyArchive.files.get('missing.json')).some(m=>m.code==='no_registration'));
  assert.equal(runVerify(legacyArchive.dir).status,0);

  // --- 6. Правка журнала в базе в обход защиты: архив прямо говорит о расхождении ---
  const tampered=records.find(r=>r.event==='MARKETING_SMS_OPT_OUT');
  // На настоящем Postgres правку запрещают триггеры: снимаем их, как мог бы владелец базы (в pg-mem триггеров нет).
  await pool.query('ALTER TABLE sms_consent_logs DISABLE TRIGGER USER').catch(()=>{});
  await pool.query("UPDATE sms_consent_logs SET metadata=$1 WHERE id=$2",[JSON.stringify({actor:'provider',source:'cabinet',forged:true}),tampered.log_id]);
  const afterTamper=unpack((await builder.build({subject:{type:'profile',id:a.id},purpose:'internal',reason:'Проверка после правки',exportId:'test0000005',settleMs:-1000})).archive);
  const integrity=JSON.parse(afterTamper.files.get('integrity.json')).checks_performed;
  assert.match(integrity[0].result,new RegExp('РАСХОЖДЕНИЕ.*#'+tampered.log_id));
  assert.match(integrity[1].result,/НАРУШЕНА.*изменена/);
  await pool.query("UPDATE sms_consent_logs SET metadata=$1 WHERE id=$2",[JSON.stringify(json(records.find(r=>r.log_id===tampered.log_id).row.metadata)),tampered.log_id]);
  await pool.query('ALTER TABLE sms_consent_logs ENABLE TRIGGER USER').catch(()=>{});

  // --- 7. Доступ: только с кодом этого запроса в этой сессии; всё в журнале ---
  const session={csrfToken:'session-one'},meta={ip:'198.51.100.99',userAgent:'admin-laptop'};
  delete process.env.ADMIN_PHONE;
  let r=await evidence.request({subject:'profile:'+a.id,purpose:'regulator',reason:'Жалоба в Службу аудита №1',session,meta});
  assert.match(r.error,/ADMIN_PHONE/);
  process.env.ADMIN_PHONE='+995599009999';
  assert.match((await evidence.request({subject:'profile:'+a.id,purpose:'regulator',reason:'коротко',session,meta})).error,/причину/);
  assert.match((await evidence.request({subject:'profile:'+a.id,purpose:'nope',reason:'Жалоба в Службу аудита №1',session,meta})).error,/цель/);
  const first=await evidence.request({subject:'profile:'+a.id,purpose:'regulator',reason:'Жалоба в Службу аудита №1',session,meta});
  assert.ok(first.requestId);
  assert.ok(sms.some(s=>s.phone==='+995599009999'),'код ушёл на телефон администратора');
  assert.deepEqual((await subjects.search(oldPhone)).profiles.map(p=>p.id),[a.id],'поиск по-прежнему находит профиль после записи кода администратора');
  r=await evidence.complete({requestId:first.requestId,code:'0000',session,meta});
  assert.equal(r.error,'Неверный код.');
  r=await evidence.complete({requestId:first.requestId,code:await redis.get('otp:evidence_export:+995599009999'),session:{csrfToken:'other'},meta});
  assert.match(r.error,/той же сессии|в той сессии/);
  const secondReq=await evidence.request({subject:'phone:'+oldPhone,purpose:'complaint',reason:'Жалоба заказчика по номеру',session,meta});
  r=await evidence.complete({requestId:first.requestId,code:await redis.get('otp:evidence_export:+995599009999'),session,meta});
  assert.match(r.error,/другой/,'код подтверждает только последний запрос');
  r=await evidence.complete({requestId:secondReq.requestId,code:await redis.get('otp:evidence_export:+995599009999'),session,meta});
  assert.ok(r.archive&&r.sha256,'выгрузка по верному коду');
  assert.equal(crypto.createHash('sha256').update(r.archive).digest('hex'),r.sha256);
  r2=await evidence.complete({requestId:secondReq.requestId,code:'1234',session,meta});
  assert.match(r2.error,/устарел/,'код и запрос одноразовые');
  const log=await evidence.recent();
  const exported=log.find(e=>e.event==='EVIDENCE_EXPORTED');
  assert.equal(exported.sha256,r.sha256);
  assert.ok(exported.tsa,'метка времени на архив');
  assert.ok((await evidence.receipt(exported.id)).data.length>0);
  const denied=log.filter(e=>e.event==='EVIDENCE_EXPORT_DENIED').map(e=>e.denied);
  for (const reason of ['no_admin_phone','wrong_code','other_session','superseded','request_expired']) assert.ok(denied.includes(reason),reason);
  assert.ok(alerts.some(t=>t.includes(r.sha256)),'метка выгрузки ушла в Telegram');
  // Запись о выгрузке входит в цепочку.
  await require('../src/services/consentChain.service').extend({settleMs:-1000});
  assert.ok((await pool.query('SELECT 1 FROM consent_log_chain WHERE log_id=$1',[exported.id])).rows.length);
  // Страница доступна только под входом администратора.
  const routes=fs.readFileSync(path.join(__dirname,'../src/routes/admin.routes.js'),'utf8');
  assert.ok(routes.indexOf('router.use(requireAdmin)')<routes.indexOf("'/evidence'"));
  assert.ok(tsaCalls>0);

  console.log('evidence-export.test.js: OK');
  process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
function json(value){return typeof value==='string'?JSON.parse(value):value;}
var r2;
