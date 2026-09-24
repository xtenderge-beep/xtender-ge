const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();require.cache[require.resolve('../src/config/db')]={exports:pool};
const redis=new(require('ioredis-mock'))();require.cache[require.resolve('../src/config/redis')]={exports:redis};
const consent=require('../src/services/consent.service'),{translate,clientStrings}=require('../src/config/i18n');
const template=fs.readFileSync(path.join(__dirname,'../src/views/join.ejs'),'utf8');
(async()=>{
 assert.ok(!template.includes('termsScrolled'));assert.ok(!template.includes('termsBody'));
 // Three steps (services, where you work, profile) plus the code screen; the short facts sit right above the checkboxes.
 assert.equal((template.match(/data-signup-panel="[0-9]"/g)||[]).length,3);assert.ok(!template.includes('data-signup-panel="3"'));
 assert.ok(template.indexOf('signupBeforeTitle')<template.indexOf('id="termsCheckbox"'),'facts come before the consent checkboxes');
 assert.ok(template.indexOf('id="nameInput"')<template.indexOf('signupBeforeTitle'),'name and phone come before the facts');
 assert.ok(template.includes('id="otpResend"')&&template.includes('id="otpChangeNumber"')&&template.includes('id="otpSentTo"'));
 assert.ok(!/<button id="sendOtpButton"[^>]*\sdisabled/.test(template));
 for(const lang of ['ka','ru','en']) {
  const snapshot=await consent.bundle('provider',lang);
  assert.equal(snapshot.acceptance_method,'explicit_checkboxes_and_sms');assert.equal(snapshot.termsScrolled,undefined);
  let body={consentLanguage:lang,consentDigest:snapshot.digest,termsAccepted:true,privacyAccepted:true};
  assert.ok((await consent.acceptedRequest({body},'provider')).consent,'no scroll flag is needed');
  assert.equal((await consent.acceptedRequest({body:{...body,termsAccepted:false}},'provider')).status,400);
  assert.equal((await consent.acceptedRequest({body:{...body,privacyAccepted:false}},'provider')).status,400);
  assert.equal((await consent.acceptedRequest({body:{...body,consentDigest:'old'}},'provider')).status,409);
  const script=ejs.render(template.match(/<script>([\s\S]*?)<\/script>/)[1],{t:translate(lang),clientStrings:clientStrings(lang),consent:snapshot});
  const elements={};
  const el=id=>elements[id]||(elements[id]={id,checked:false,disabled:false,value:'test',hidden:false,attributes:{},
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},focus(){this.focused=true;},blur(){},scrollIntoView(){},
    setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},addEventListener(){}});
  ['termsCheckbox','privacyCheckbox'].forEach(el);
  let sends=0;
  const context=vm.createContext({setInterval:()=>1,clearInterval(){},window:{innerWidth:1000,GeorgianPhone:{validate:()=>true}},
    document:{body:el('body'),getElementById:id=>id==='providerIllustrationTrack'?null:el(id),
      querySelector:selector=>el(selector.replace('#','')),querySelectorAll:selector=>selector.includes(':checked')?[{value:'1'}]:[]},
    fetch:async()=>{sends++;return {json:async()=>({success:true,challengeId:'test'})};},
  });
  vm.runInContext(script,context);
  await vm.runInContext('sendOtp()',context);assert.equal(sends,0);assert.equal(el('termsCheckbox').focused,true);
  assert.equal(el('termsError').textContent,translate(lang)('signup_terms_required'));
  el('termsCheckbox').checked=true;await vm.runInContext('sendOtp()',context);assert.equal(sends,0);
  assert.equal(el('privacyError').textContent,translate(lang)('signup_privacy_required'));
  el('privacyCheckbox').checked=true;await vm.runInContext('sendOtp()',context);assert.equal(sends,1);
  assert.equal(el('sendOtpButton').disabled,false);
  assert.ok(el('otpSentTo').textContent.includes('test'),'the code screen names the number the code went to');
  assert.equal(el('otpResend').disabled,true,'resend is on cooldown right after sending');
  await vm.runInContext('sendOtp(true)',context);assert.equal(sends,2,'resend sends a new code');
  assert.equal(el('formMsg').textContent,translate(lang)('js_ok_code_sent'));
  // On the code screen the header back arrow means "change the number": it returns to the profile step.
  assert.equal(vm.runInContext('otpVisible',context),true);
  vm.runInContext('changeSignupStep(0)',context);
  assert.equal(vm.runInContext('otpVisible',context),false);
  assert.equal(vm.runInContext('signupStep',context),2);
  // An existing account gets a working login action without advancing to another SMS screen.
  vm.runInContext("showSignupError({code:'MASTER_ALREADY_REGISTERED',message:'Already registered'}, 'Error')",context);
  assert.equal(el('existingProfileLogin').hidden,false);
  assert.equal(el('existingProfileLogin').focused,true);
  assert.equal(el('formMsg').textContent,'Already registered');
 }
 console.log('PASS: three signup steps, no scroll gate, active CTA, resend, inline unchecked errors, SMS only after explicit consent and stale-document protection in 3 languages');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
