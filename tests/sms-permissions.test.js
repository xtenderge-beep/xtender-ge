// Два независимых разрешения исполнителя на SMS: заявки и предложения Xtender. Выбор при регистрации, отдельный
// переключатель предложений (вход по коду их не возвращает), ссылка Stop в SMS о заявке («Это не мой номер»),
// пауза после двух неоткрытых заявок по SMS и снятие паузы только новым кодом. Каждое изменение — в журнале
// согласий, включения — с точным показанным текстом и его версией.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
const redis=new(require('ioredis-mock'))();
stub('../src/config/db',pool);stub('../src/config/redis',redis);
const sms=[];
stub('../src/services/sms.service',{
  sendOrderNotification:async(phone,text,context)=>{sms.push({phone,text,kind:context?.kind});return {ok:true,providerMessageId:'test'};},
  sendOtp:async(phone,code)=>{sms.push({phone,text:'Code: '+code,kind:'otp'});return {ok:true,providerMessageId:'otp'};},
});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{},notifyModeratorNewMaster:async()=>{}});
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service');
const consent=require('../src/services/consent.service'),otp=require('../src/services/otp.service');
const permissions=require('../src/services/smsPermissions.service'),pause=require('../src/services/leadPause.service');
const cabinet=require('../src/controllers/master.controller'),stopPage=require('../src/controllers/leadStop.controller');
const {translate}=require('../src/config/i18n');
let seq=0;
async function provider(name,extra={}) {
  const m=await masters.registerMaster({name,phone:'+99550000850'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query("UPDATE masters SET language='ru' WHERE id=$1",[m.id]);
  if(extra.telegram) await pool.query('UPDATE masters SET telegram_id=$2 WHERE id=$1',[m.id,extra.telegram]);
  return (await pool.query('SELECT * FROM masters WHERE id=$1',[m.id])).rows[0];
}
const row=async id=>(await pool.query('SELECT * FROM masters WHERE id=$1',[id])).rows[0];
const json=value=>typeof value==='string' ? JSON.parse(value) : value;
const journal=async(id,types)=>(await pool.query('SELECT * FROM sms_consent_logs WHERE master_id=$1 ORDER BY id',[id])).rows.filter(r=>!types || types.includes(r.event_type));
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},set(){return this;},render(view,data){this.view=view;this.data=data;}});
const request=extra=>({params:{},query:{},body:{},headers:{},lang:'ru',ip:'198.51.100.7',get:()=> 'test-agent',cookies:{},...extra});
let orderSeq=0;
const newOrder=()=>pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,'+995500008999','Перенести шкаф','pending_review',$3) RETURNING *",['perm-'+(++orderSeq),'perm-owner-'+orderSeq,[]]).then(r=>r.rows[0]);
const send=async()=>{const order=await newOrder();await dispatch.sendNeeds(order.token,{needs:['movers']},null,'',{actor:'test'});return order;};
const leadSms=(master)=>sms.filter(s=>s.kind==='lead' && s.phone===master.phone);

(async()=>{
  // 1. Регистрация: обе отметки необязательны и не зависят друг от друга; текст и выбор — в снимке согласия.
  const snapshot=await consent.bundle('provider','ru');
  const t=translate('ru');
  assert.ok(!snapshot.termsLabel.includes('уведомления'),'согласие на SMS больше не спрятано в оферте');
  assert.equal(snapshot.leadSms.title,t('signup_lead_sms_title'));assert.equal(snapshot.marketingSms.title,t('signup_marketing_sms_title'));
  const base={consentLanguage:'ru',consentDigest:snapshot.digest,termsAccepted:true,privacyAccepted:true};
  const accepted=(await consent.acceptedRequest({body:{...base,leadSmsAccepted:true}},'provider')).consent;
  assert.deepEqual(accepted.choices,{lead_sms:true,marketing_sms:false});
  for (const text of [t('signup_lead_sms'),t('signup_marketing_sms'),'Отмечено: заявки по SMS — да; предложения Xtender — нет.']) assert.ok(accepted.text.includes(text),text);
  async function register(name,choices) {
    const phone='+99550000860'+(++seq);
    const consentForCode=(await consent.acceptedRequest({body:{...base,...choices}},'provider')).consent;
    const sent=await otp.sendCode(phone,'master',null,{consent:consentForCode});
    assert.equal(await otp.verifyCode(phone,await redis.get('otp:master:'+phone),'master',{challengeId:sent.challengeId,strict:true}),true);
    const grant=await otp.getConsentGrant(phone,'master',sent.challengeId);
    const master=await masters.registerMaster({createOnly:true,name,phone,serviceType:null,consentGrant:grant,cityIds:[1],cityId:1,spokenLanguages:['ru']});
    await permissions.applyRegistration(master.id,phone,grant,{ip:'198.51.100.7'});
    return row(master.id);
  }
  const leadsOnly=await register('Только заявки',{leadSmsAccepted:true});
  assert.deepEqual([leadsOnly.is_subscribed,leadsOnly.marketing_sms],[true,false]);
  const optIn=(await journal(leadsOnly.id,['LEAD_SMS_OPT_IN']))[0];
  assert.deepEqual([json(optIn.metadata).source,optIn.consent_text_snapshot,optIn.terms_version],['registration',t('signup_lead_sms_title')+'. '+t('signup_lead_sms'),permissions.permissionText('lead','ru').version]);
  assert.equal((await journal(leadsOnly.id,['MARKETING_SMS_OPT_IN'])).length,0);
  const offersOnly=await register('Только предложения',{marketingSmsAccepted:true});
  assert.deepEqual([offersOnly.is_subscribed,offersOnly.marketing_sms],[false,true],'без отметки заявок заявки не приходят, предложения — отдельно');
  const nothing=await register('Без отметок',{});
  assert.deepEqual([nothing.is_subscribed,nothing.marketing_sms],[false,false]);
  // Старый вызов без выбора (прежняя единая отметка): ничего не меняем.
  assert.deepEqual(await permissions.applyRegistration(nothing.id,nothing.phone,{snapshot:{}},{}),{lead:true,marketing:false,legacy:true});
  assert.deepEqual([(await row(nothing.id)).is_subscribed,(await row(nothing.id)).marketing_sms],[false,false]);

  // 2. Предложения в кабинете: выключить, войти по коду — согласие не возвращается; включить — с текстом на языке кабинета.
  let res=response();
  await cabinet.setMarketing(request({params:{token:offersOnly.master_token},body:{subscribed:false}}),res);
  assert.deepEqual(res.data,{success:true,subscribed:false});
  const login=await otp.sendCode(offersOnly.phone,'master_login',null,{});
  assert.equal(login.success,true);
  assert.equal(await otp.verifyCode(offersOnly.phone,await redis.get('otp:master_login:'+offersOnly.phone),'master_login',{masterId:offersOnly.id}),true);
  assert.equal((await row(offersOnly.id)).marketing_sms,false,'вход по коду не включает предложения');
  await pool.query("UPDATE masters SET language='ka' WHERE id=$1",[offersOnly.id]);
  res=response();await cabinet.setMarketing(request({params:{token:offersOnly.master_token},body:{subscribed:true}}),res);
  assert.deepEqual(res.data,{success:true,subscribed:true});
  const reconsent=(await journal(offersOnly.id,['MARKETING_SMS_OPT_IN'])).at(-1);
  assert.deepEqual([json(reconsent.metadata).source,reconsent.consent_language,reconsent.consent_text_snapshot],['cabinet','ka',translate('ka')('signup_marketing_sms_title')+'. '+translate('ka')('signup_marketing_sms')]);
  assert.deepEqual((await journal(offersOnly.id,['MARKETING_SMS_OPT_IN','MARKETING_SMS_OPT_OUT'])).map(r=>r.event_type),['MARKETING_SMS_OPT_IN','MARKETING_SMS_OPT_OUT','MARKETING_SMS_OPT_IN']);
  assert.equal(permissions.canSendMarketing(await row(offersOnly.id)),true);assert.equal(permissions.canSendMarketing(await row(leadsOnly.id)),false);

  // 3. Ссылка Stop в каждой SMS о заявке: отказ без входа; «Это не мой номер» выключает и предложения.
  const giorgi=await provider('Гиорги'),levan=await provider('Леван'),nino=await provider('Нино',{telegram:5551});
  await pool.query('UPDATE masters SET is_active=false WHERE id IN ($1,$2,$3)',[leadsOnly.id,offersOnly.id,nothing.id]);
  const first=await send();
  const text=leadSms(giorgi)[0].text;
  const code=text.match(/ Stop: \S+\/stop\/([A-Za-z0-9_-]+)$/)[1];
  assert.ok(text.length<=160);
  res=response();await stopPage.show(request({params:{code}}),res);
  assert.deepEqual([res.statusCode,res.view,res.data.found,res.data.phone],[200,'lead-stop',true,'••• '+giorgi.phone.slice(-3)]);
  res=response();await stopPage.stop(request({params:{code},body:{action:'stop'}}),res);
  assert.deepEqual([res.statusCode,res.data.done],[200,'stop']);
  assert.equal((await row(giorgi.id)).is_subscribed,false);
  const stopRow=(await journal(giorgi.id,['LEAD_SMS_OPT_OUT'])).at(-1);
  assert.deepEqual([json(stopRow.metadata).actor,json(stopRow.metadata).source,json(stopRow.metadata).reason],['phone_holder','sms_stop','stop_link']);
  await pool.query('UPDATE masters SET marketing_sms=true WHERE id=$1',[levan.id]);
  const levanCode=leadSms(levan)[0].text.match(/\/stop\/([A-Za-z0-9_-]+)$/)[1];
  res=response();await stopPage.stop(request({params:{code:levanCode},body:{action:'not_mine'}}),res);
  assert.equal(res.data.done,'not_mine');
  assert.deepEqual([(await row(levan.id)).is_subscribed,(await row(levan.id)).marketing_sms],[false,false]);
  assert.ok((await pool.query("SELECT 1 FROM master_admin_events WHERE master_id=$1 AND action='phone_not_mine'",[levan.id])).rows.length);
  res=response();await stopPage.show(request({params:{code:'NoSuchCode1'}}),res);
  assert.deepEqual([res.statusCode,res.data.found],[404,false]);
  assert.equal(first.id>0,true);

  // 4. Пауза: две заявки по SMS, которые открыли другие, а он нет, — третья не уходит, приходит одна SMS о паузе.
  await pool.query('UPDATE masters SET is_subscribed=true WHERE id IN ($1,$2)',[giorgi.id,levan.id]);
  await pool.query("DELETE FROM dispatch_deliveries");
  const age=()=>pool.query("UPDATE dispatch_deliveries SET finished_at=$1",[new Date(Date.now()-3*60*60*1000)]);
  const a=await send(),b=await send();
  await age();
  for (const order of [a,b]) await pool.query("INSERT INTO order_views(order_id,master_id,event_type) VALUES($1,$2,'view')",[order.id,levan.id]);
  const before=leadSms(giorgi).length;
  const c=await send();
  assert.equal(leadSms(giorgi).length,before,'третья заявка по SMS не ушла');
  assert.ok((await row(giorgi.id)).lead_sms_paused_at,'пауза поставлена');
  assert.deepEqual((await pool.query('SELECT status, reason FROM dispatch_deliveries WHERE order_id=$1 AND master_id=$2',[c.id,giorgi.id])).rows[0],{status:'skipped',reason:'sms_paused'});
  assert.equal(sms.filter(s=>s.phone===giorgi.phone && s.text.startsWith('Xtender: order SMS paused')).length,1);
  assert.deepEqual(json((await journal(giorgi.id,['LEAD_SMS_PAUSED'])).at(-1).metadata).unopened_order_ids,[b.id,a.id].map(Number));
  assert.equal((await row(levan.id)).lead_sms_paused_at,null,'открывший заявки не на паузе');
  assert.equal((await row(nino.id)).lead_sms_paused_at,null,'заявки в Telegram паузе не подвержены');
  // На паузе его нет среди получателей следующей заявки.
  await send();
  assert.equal(leadSms(giorgi).length,before);

  // Снять паузу можно только кодом на номер, без кода — нет.
  res=response();await cabinet.verifyResumeCode(request({params:{token:giorgi.master_token},body:{code:'0000'}}),res);
  assert.equal(res.statusCode,400);assert.ok((await row(giorgi.id)).lead_sms_paused_at);
  res=response();await cabinet.sendResumeCode(request({params:{token:giorgi.master_token}}),res);
  assert.deepEqual(res.data,{success:true});
  res=response();await cabinet.verifyResumeCode(request({params:{token:giorgi.master_token},body:{code:await redis.get('otp:lead_resume:'+giorgi.phone)}}),res);
  assert.deepEqual(res.data,{success:true,resumed:true});
  const after=await row(giorgi.id);
  assert.deepEqual([after.lead_sms_paused_at,Boolean(after.lead_sms_resumed_at)],[null,true]);
  assert.deepEqual((await journal(giorgi.id,['LEAD_RESUME_OTP_VERIFIED','LEAD_SMS_RESUMED'])).map(r=>r.event_type),['LEAD_RESUME_OTP_VERIFIED','LEAD_SMS_RESUMED']);
  // Отсчёт начинается заново: старые неоткрытые заявки больше не считаются.
  await send();
  assert.equal(leadSms(giorgi).length,before+1);
  res=response();await cabinet.sendResumeCode(request({params:{token:giorgi.master_token}}),res);
  assert.equal(res.statusCode,409,'без паузы код не нужен');
  assert.equal(pause.isPaused(await row(giorgi.id)),false);

  console.log('sms-permissions.test.js: OK');
  process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
