const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { newDb } = require('pg-mem');
const Redis = require('ioredis-mock');
const ejs = require('ejs');

const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => {
  const before = db.backup();
  try { return await fn(pool); } catch (err) { before.restore(); throw err; }
};
const redis = new Redis();
function stub(modulePath, exports) { require.cache[require.resolve(modulePath)] = { exports }; }
stub('../src/config/db', pool);
stub('../src/config/redis', redis);
let sent = 0;
stub('../src/services/sms.service', {
  sendOtp: async () => ({ providerMessageId: String(++sent), providerResponse: { accepted: true } }),
  sendOrderNotification: async () => ({ providerMessageId: String(++sent), providerResponse: { accepted: true } }),
});
stub('../src/services/telegram.service', { notifyModerator: async()=>null, updateMessage: async()=>{}, notifyModeratorNewMaster: async()=>{} });
stub('../src/services/translation.service', { translateOrder: async()=>null });
const consent = require('../src/services/consent.service');
const log = require('../src/services/consentLog.service');
const otp = require('../src/services/otp.service');
const orders = require('../src/services/order.service');
const masters = require('../src/services/master.service');
const orderController = require('../src/controllers/order.controller');
const masterController = require('../src/controllers/master.controller');
const otpController = require('../src/controllers/otp.controller');
const { translate, clientStrings } = require('../src/config/i18n');
const serviceTypes = require('../src/config/serviceTypes');
const { buildSeo } = require('../src/config/seo');
const legalContent = require('../src/config/legal-content');
const { SERVICE_REQUISITES } = require('../src/config/legal');

function response() {
  return { statusCode: 200, status(n) { this.statusCode=n;return this; }, json(data) { this.data=data;return this; }, cookie(){}, clearCookie(){} };
}
const request = body => ({ body, cookies: {}, headers: {}, get:()=> 'localhost', lang: 'ru', protocol: 'http', ip:'127.0.0.1' });
async function issue(phone, purpose, orderId=null) {
  const snapshot = await consent.bundle(purpose === 'order' ? 'client' : 'provider', 'ru');
  const result = await otp.sendCode(phone, null, purpose, orderId, { consent: snapshot });
  const code = await redis.get(`otp:${purpose}:${phone}`);
  return { snapshot, code, challengeId: result.challengeId };
}
async function verify(phone, purpose, flow) {
  assert.equal(await otp.verifyCode(phone, flow.code, purpose, { challengeId: flow.challengeId }), true);
  return otp.getConsentGrant(phone, purpose, flow.challengeId);
}
async function render(file, locals) {
  const html = await ejs.renderFile(path.join(__dirname,'../src/views',file),locals);
  // Catch syntax errors in inline browser scripts after EJS interpolation.
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/application\/ld\+json|\bsrc=/.test(script[1]) && script[2].trim()) new vm.Script(script[2],{filename:file});
  }
  return html;
}

(async()=>{
  const bundle=await consent.bundle('client','ru');
  const acceptance={termsAccepted:true,privacyAccepted:true,consentLanguage:'ru',consentDigest:bundle.digest};
  assert.ok((await consent.acceptedRequest(request(acceptance),'client')).consent);
  assert.equal((await consent.acceptedRequest(request({...acceptance,termsAccepted:'false'}),'client')).status,400);
  assert.equal((await consent.acceptedRequest(request({...acceptance,consentDigest:'old'}),'client')).status,409);
  let res=response();await otpController.send(request({phone:'+995500000001',description:'Test'}),res);
  assert.equal(res.statusCode,400);assert.equal(sent,0);

  const phone='+995500000001';
  const pending=await orders.createPendingOrder({phone,description:'Move a table',districtName:'Test'});
  const flow=await issue(phone,'order',pending.id);
  assert.equal(await otp.verifyCode(phone,flow.code,'order',{}),false);
  assert.equal(await otp.verifyCode(phone,flow.code,'order',{challengeId:'a'.repeat(48)}),false);
  const grant=await verify(phone,'order',flow);
  assert.equal(await otp.isPhoneVerified(phone,'order'),false);
  assert.equal(await otp.getConsentGrant(phone,'order','b'.repeat(48)),null);
  assert.equal(await otp.verifyCode(phone,flow.code,'order',{challengeId:flow.challengeId}),false);
  let rows=(await pool.query("SELECT * FROM sms_consent_logs WHERE event_type='CLIENT_CONSENT_OTP_VERIFIED'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].order_id,pending.id);
  assert.equal(rows[0].metadata.snapshot.documents.terms.version,bundle.terms_version);
  assert.equal(rows[0].consent_text_snapshot,bundle.text);
  const other=await orders.createPendingOrder({phone,description:'Another request',districtName:''});
  assert.equal(await orders.activateOrder(other.token,phone,grant),null);
  const published=await orders.activateOrder(pending.token,phone,grant,{ip:'127.0.0.1'});
  assert.equal(published.status,'pending_review');
  assert.equal(await orders.activateOrder(pending.token,phone,grant),null);

  // A forged old cookie cannot close a request; possession of the SMS secret can.
  res=response();await orderController.close({...request({reason:'found_provider'}),params:{token:pending.token},cookies:{['order_'+pending.token]:'1'}},res);
  assert.equal(res.statusCode,403);
  res=response();await orderController.close({...request({reason:'invalid'}),params:{token:pending.token},cookies:{['order_'+pending.token]:pending.owner_token}},res);
  assert.equal(res.statusCode,400);
  const query=pool.query.bind(pool);
  pool.query=async(sql,...args)=>{if(sql.includes('INSERT INTO sms_consent_logs'))throw Error('audit unavailable');return query(sql,...args);};
  await assert.rejects(()=>orders.closeOrder(pending.token,{actor:'client',reason:'found_provider'}),/audit unavailable/);
  pool.query=query;
  assert.equal((await orders.getOrderByToken(pending.token)).status,'pending_review');
  res=response();await orderController.close({...request({reason:'found_provider'}),params:{token:pending.token},cookies:{['order_'+pending.token]:pending.owner_token}},res);
  assert.equal(res.data.success,true);
  assert.equal((await orders.getOrderByToken(pending.token)).status,'closed');
  const before=sent;assert.equal(await orders.notifyMasters(published,'transport',null),0);assert.equal(sent,before);
  res=response();await orderController.close({...request({reason:'found_provider'}),params:{token:pending.token},cookies:{['order_'+pending.token]:pending.owner_token}},res);
  assert.equal(res.data.success,true);
  rows=(await pool.query("SELECT * FROM sms_consent_logs WHERE event_type='ORDER_CLOSED'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].metadata.actor,'client');assert.equal(rows[0].metadata.reason,'found_provider');
  assert.equal((await pool.query("SELECT * FROM sms_consent_logs WHERE event_type='CONTACT_SHARING_WITHDRAWN'")).rows.length,1);

  // Database failure must not consume the valid OTP or allow publication without evidence.
  const failedPhone='+995500000002',failed=await issue(failedPhone,'order',other.id);
  pool.query=async(sql,...args)=>{if(sql.includes('INSERT INTO sms_consent_logs'))throw Error('audit unavailable');return query(sql,...args);};
  await assert.rejects(()=>otp.verifyCode(failedPhone,failed.code,'order',{challengeId:failed.challengeId}),/audit unavailable/);
  pool.query=query;
  assert.equal(await redis.get('otp:order:'+failedPhone),failed.code);
  assert.equal(await otp.getConsentGrant(failedPhone,'order',failed.challengeId),null);
  await verify(failedPhone,'order',failed);

  const lockedPhone='+995500000003',locked=await issue(lockedPhone,'master');
  for(let i=0;i<5;i++)assert.equal(await otp.verifyCode(lockedPhone,'0000','master',{challengeId:locked.challengeId}),false);
  assert.equal(await otp.verifyCode(lockedPhone,locked.code,'master',{challengeId:locked.challengeId}),false);
  const providerPhone='+995500000004',provider=await issue(providerPhone,'master');
  res=response();await masterController.verifyOtp(request({phone:providerPhone,code:provider.code,challengeId:provider.challengeId,termsAccepted:'false',privacyAccepted:'false'}),res);
  assert.equal(res.statusCode,400);
  const providerGrant=await verify(providerPhone,'master',provider);
  const args={phone:providerPhone,name:'Provider',serviceType:'movers',attributes:{},consentGrant:providerGrant};
  const master=await masters.registerMaster(args);
  await assert.rejects(()=>masters.registerMaster({...args,name:'Replay takeover'}));
  assert.equal((await masters.getMasterById(master.id)).name,'Provider');
  // The name the person declared when accepting is frozen in the evidence, independent of later profile edits.
  const registered=(await pool.query("SELECT metadata FROM sms_consent_logs WHERE event_type='MASTER_REGISTERED' AND master_id=$1",[master.id])).rows;
  assert.equal(registered.length,1);assert.equal(registered[0].metadata.declared_name,'Provider');
  assert.equal(Number(registered[0].metadata.consent_log_id),Number(providerGrant.consentLogId));
  assert.equal(registered[0].metadata.profile_action,'created');
  // Public signup must neither send another registration SMS nor modify an existing profile.
  await pool.query('UPDATE masters SET is_active=true WHERE id=$1',[master.id]);
  const beforeProfile=await masters.getMasterById(master.id);
  const beforeEvents=(await pool.query('SELECT * FROM sms_consent_logs')).rows;
  const beforeSms=sent;
  for (const lang of ['ru','en','ka']) {
    const duplicateResponse=response();
    await masterController.sendOtp({...request({phone:providerPhone}),lang},duplicateResponse);
    assert.equal(duplicateResponse.statusCode,409);
    assert.equal(duplicateResponse.data.code,'MASTER_ALREADY_REGISTERED');
    assert.equal(duplicateResponse.data.message,clientStrings(lang).join_existing_profile);
    assert.equal(duplicateResponse.data.loginUrl,'/master');
  }
  assert.equal(sent,beforeSms);
  // Covers a profile created after OTP send but before registration: the SQL conflict guard wins.
  await assert.rejects(()=>masters.registerMaster({...args,createOnly:true,name:'Overwrite attempt'}),
    {code:'MASTER_ALREADY_REGISTERED'});
  assert.deepEqual(await masters.getMasterById(master.id),beforeProfile);
  assert.deepEqual((await pool.query('SELECT * FROM sms_consent_logs')).rows,beforeEvents);
  const originalRegister=masters.registerMaster;
  masters.registerMaster=async input=>{assert.equal(input.createOnly,true);const err=new Error('exists');err.code='MASTER_ALREADY_REGISTERED';throw err;};
  const cities=await masters.getWorkCities();
  const duplicateResponse=response();
  await masterController.register(request({phone:providerPhone,name:'Overwrite',description:'Moving',spokenLanguages:['ru'],
    cityIds:[String(cities[0].id)],termsAccepted:'true',privacyAccepted:'true',challengeId:provider.challengeId}),duplicateResponse);
  masters.registerMaster=originalRegister;
  assert.equal(duplicateResponse.statusCode,409);
  const newProfile=await masters.registerMaster({phone:'+995500000099',name:'New profile',description:'Moving',serviceType:null,createOnly:true});
  assert.equal(newProfile.name,'New profile');
  const recent=await log.listRecentConsents();
  assert.ok(recent.some(row=>row.event_type==='MASTER_REGISTERED' && row.metadata.profile_action==='created'));
  assert.ok(recent.some(row=>row.event_type==='CLIENT_CONSENT_OTP_VERIFIED' && row.order_id===pending.id));
  const recentHtml=await render('admin/consent.ejs',{phoneQuery:'',report:null,recent,csrfToken:'test'});
  assert.ok(recentHtml.includes('Профиль создан'));
  assert.ok(recentHtml.includes('Текущий профиль по номеру'));
  const report=await log.exportForPhone(phone);
  assert.equal(report.client_consents.length,1);
  assert.ok(report.events.some(e=>e.event_type==='ORDER_PUBLISHED'));

  for(const lang of ['ru','en','ka']) {
    const t=translate(lang);
    const common={lang,t,clientStrings:clientStrings(lang),currentPath:'/',isRememberedProvider:false,csrfToken:'test',seo:buildSeo(lang,'/')};
    const html=await render('index.ejs',{...common,masters:[],catalogCallPriceTetri:50,prefillPhone:'',catalogGroups:serviceTypes.catalogGroupsForView(t),consent:await consent.bundle('client',lang)});
    assert.ok(html.includes('id="clientSharing"'));assert.ok(!/id="clientSharing"[^>]*checked/.test(html));
    await render('join.ejs',{...common,consent:await consent.bundle('provider',lang),legalDoc:legalContent.terms,reqLabels:legalContent.REQUISITE_LABELS,reqPending:legalContent.REQUISITE_PENDING,requisites:SERVICE_REQUISITES,welcomeBonusTetri:0,leadPriceTetri:50,catalogCallPriceTetri:50,promo:null,serviceConfig:serviceTypes.configForView(t),cities:[{id:1,name:'Tbilisi'}],districtsByCity:{1:[]}});
    await render('order.ejs',{...common,order:published,files:[],isOwner:true,masterId:null,masterCategory:null,funnel:null,masterAccount:null,targetCategories:[],closedCategories:[],categoryLabels:{},whatsappText:''});
  }
  await render('admin/consent.ejs',{phoneQuery:phone,report,recent:[],csrfToken:'test'});
  const { renderDocBody } = require('../src/config/legalTextFormat');
  const toText = (doc) => ({ ka: renderDocBody(doc.body.ka), ru: renderDocBody(doc.body.ru), en: renderDocBody(doc.body.en) });
  await render('admin/legal.ejs',{terms:legalContent.terms,privacy:legalContent.privacy,termsText:toText(legalContent.terms),privacyText:toText(legalContent.privacy),errorDoc:null,error:null,saved:null,csrfToken:'test'});
  console.log('PASS: consent validation, exact document archive, OTP challenge isolation/replay/attempt limits, strict failure, request binding, transactional publication/closure, forged owner cookie, provider grant reuse, exports and rendered scripts in ru/en/ka. No real SMS or database used.');
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>redis.disconnect());
