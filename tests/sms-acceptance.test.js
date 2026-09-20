const assert = require('node:assert/strict');
let reply, networkFailure=false;
require.cache[require.resolve('axios')]={exports:{get:async()=>{if(networkFailure)throw Error('timeout');return {data:reply};}}};
const events=[];
require.cache[require.resolve('../src/services/consentLog.service')]={exports:{recordSmsDelivery:async event=>events.push(event)}};
process.env.NODE_ENV='test';process.env.SMS_GATEWAY_USERNAME='test';process.env.SMS_GATEWAY_PASSWORD='test';
const sms=require('../src/services/sms.service');
(async()=>{
  for(const data of ['OK: 123456','OK 123456',123456,'123456',{ok:true,message_id:123},{status:'accepted',id:123},'{"success":true,"id":123}']) {
    reply=data;const result=await sms.sendOrderNotification('+995500000001','test');
    assert.equal(result.ok,true);assert.equal(result.status,'accepted');assert.equal(result.messageBody,'test');
  }
  for(const data of ['ERROR: 123456','OK: ERROR','OK: -1','<html>failure</html>',0,-1,'0','',null,{ok:false,id:123},{success:false,id:123},{status:'failed',id:123},{id:123},{ok:true},'{invalid']) {
    reply=data;await assert.rejects(sms.sendOrderNotification('+995500000001','test'),{code:'SMS_NOT_ACCEPTED'});
  }
  networkFailure=true;await assert.rejects(sms.sendOrderNotification('+995500000001','test'),/timeout/);
  assert.equal(events.at(-1).status,'failed');
  process.env.NODE_ENV='production';delete process.env.SMS_GATEWAY_USERNAME;
  await assert.rejects(sms.sendOrderNotification('+995500000001','test'),/credentials are not configured/);
  console.log('PASS: gateway receipt validation, HTTP 200 failures, unknown replies and transport failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
