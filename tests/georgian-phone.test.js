const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {newDb}=require('pg-mem');
const db=newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();pool.withTransaction=async fn=>fn(pool);
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
const redis=new(require('ioredis-mock'))();stub('../src/config/db',pool);stub('../src/config/redis',redis);
let sends=0;
stub('../src/services/sms.service',{sendOtp:async()=>{sends++;return {ok:true};},sendOrderNotification:async()=>{sends++;return {ok:true};}});
stub('../src/services/telegram.service',{notifyModerator:async()=>null});
const policy=require('../public/js/georgian-phone');
const otp=require('../src/services/otp.service');
const orderOtp=require('../src/controllers/otp.controller');
const orders=require('../src/controllers/order.controller');
const masters=require('../src/controllers/master.controller');
const reviews=require('../src/controllers/review.controller');
const res=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}});
const request=phone=>({body:{phone,code:'1234',token:'not-used',challengeId:'a'.repeat(48),masterId:1,name:'Test',description:'Test request',termsAccepted:true,privacyAccepted:true,spokenLanguages:['ru']},cookies:{},lang:'ru',headers:{}});
(async()=>{
 for(const phone of ['+995500001001','+995 500 001 001',' +995 500001001 '])assert.equal(policy.normalize(phone),'+995500001001');
 const invalid=['+14155552671','+447911123456','+79991234567','+37499123456','+995','+99550000100','+9955000010010','995500001001','500001001','00995500001001','+995+500001001','abc+995500001001','+995５００００１００１',123456789,{phone:'+995500001001'},null];
 const endpoints=[orderOtp.send,orderOtp.verify,orders.create,masters.catalogOtpSend,masters.catalogOtpVerify,masters.sendOtp,masters.verifyOtp,masters.register,masters.loginRequestCode,masters.loginVerify,reviews.requestCode,reviews.verifyForMaster,reviews.submit];
 for(const phone of invalid){
  assert.equal(policy.isValid(phone),false,String(phone));
  for(const endpoint of endpoints){const response=res();await endpoint(request(phone),response);assert.equal(response.statusCode,400,endpoint.name+': '+String(phone));}
 }
 assert.equal(sends,0);assert.equal((await pool.query('SELECT * FROM orders')).rows.length,0,'invalid phones do not create drafts');
 for(const purpose of ['order','master','master_login','review','catalog','admin_login']){
  for(const phone of ['+447911123456','+99550000100','500001001']){
   assert.deepEqual(await otp.sendCode(phone,null,purpose),{success:false,reason:'invalid_phone'});
   assert.deepEqual(await otp.sendCode(phone,'/o/test',purpose),{success:false,reason:'invalid_phone'});
   await redis.set('otp:'+purpose+':'+phone,'1234');await redis.set('verified:'+purpose+':'+phone,'1');
   await redis.set('consent_grant:'+purpose+':'+phone+':'+'a'.repeat(48),JSON.stringify({consentLogId:1}));
   assert.equal(await otp.verifyCode(phone,'1234',purpose,{recordConsent:false}),false);
   assert.equal(await otp.isPhoneVerified(phone,purpose),false);
   assert.equal(await otp.getConsentGrant(phone,purpose,'a'.repeat(48)),null);
  }
 }
 assert.equal(sends,0,'central service never contacts a gateway for foreign numbers');
 assert.equal((await otp.sendCode('+995500001002',null,'review')).success,true);
 const code=await redis.get('otp:review:+995500001002');assert.ok(code);
 assert.equal(await otp.verifyCode('+995500001002',code,'review',{recordConsent:false}),true);
 assert.equal(await otp.isPhoneVerified('+995500001002','review'),true);
 assert.equal(sends,1);
 // Browser uses the exact same normalizer and reports localized validation.
 for(const lang of ['ru','en','ka']){
  let domReady,reported=0,custom='';
  const input={value:'+447911123456',setCustomValidity(value){custom=value;},reportValidity(){reported++;},addEventListener(){}};
  const context={window:{},document:{documentElement:{lang},addEventListener(name,fn){domReady=fn;},querySelectorAll(){return [input];}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/georgian-phone.js'),'utf8'),context);
  domReady();assert.equal(context.window.GeorgianPhone.validate(input),false);assert.equal(custom,policy.message(lang));assert.equal(reported,1);
  input.value='+995 500 001 001';assert.equal(context.window.GeorgianPhone.validate(input),true);assert.equal(custom,'');
 }
 // Foreign operator entries are rejected before any CRM writes.
 await assert.rejects(require('../src/services/crm.service').invite(1,{phone:'+447911123456'}),/грузинский/);
 // Direct low-level OTP calls also enforce the country restriction.
 delete require.cache[require.resolve('../src/services/sms.service')];
 const sms=require('../src/services/sms.service');assert.throws(()=>sms.sendOtp('+447911123456','1234'),/Georgian/);
 console.log('PASS Georgian-only phone policy: all public send/verify/register routes, invalid types and lengths, mandatory +995, no foreign SMS/drafts, cached foreign proofs rejected, valid Georgian OTP, localized browser checks, CRM and low-level OTP guard');
})().catch(error=>{console.error(error);process.exitCode=1;});
