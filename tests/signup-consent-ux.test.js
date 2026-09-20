const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();require.cache[require.resolve('../src/config/db')]={exports:pool};
const redis=new(require('ioredis-mock'))();require.cache[require.resolve('../src/config/redis')]={exports:redis};
const consent=require('../src/services/consent.service'),{translate,clientStrings}=require('../src/config/i18n');
const template=fs.readFileSync(path.join(__dirname,'../src/views/join.ejs'),'utf8');
(async()=>{
 assert.ok(!template.includes('termsScrolled'));assert.ok(!template.includes('termsBody'));
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
  const context=vm.createContext({window:{innerWidth:1000,GeorgianPhone:{validate:()=>true}},
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
 }
 console.log('PASS: no scroll gate, active CTA, inline unchecked errors, SMS only after explicit consent and stale-document protection in 3 languages');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
