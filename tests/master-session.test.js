const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const express = require('express');
const cookieParser = require('cookie-parser');
const redis = new (require('ioredis-mock'))();
require.cache[require.resolve('../src/config/redis')] = { exports: redis };
const session = require('../src/services/masterSession.service');
const { translate, clientStrings } = require('../src/config/i18n');
(async () => {
  const cookies = [];
  const res = { cookie: (name,value) => cookies.push(`${name}=${value}`) };
  await session.start({cookies:{}},res,'token-a');
  await session.start({cookies:{}},res,'token-a');
  const app = express(); app.use(cookieParser());
  app.get('/api/master/:token', (req,res,next)=>session.requireSession(req,res,next).catch(next), (req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.listening?r():server.once('listening',r));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/master/`;
    assert.equal((await fetch(url+'token-a')).status,401);
    assert.equal((await fetch(url+'token-a',{headers:{cookie:'master_session=token-a'}})).status,401);
    assert.equal((await fetch(url+'token-b',{headers:{cookie:cookies[0]}})).status,401);
    assert.equal((await fetch(url+'token-a',{headers:{cookie:cookies[0]}})).status,200);
    await session.revoke({cookies:{master_session:cookies[0].split('=')[1]}});
    assert.equal((await fetch(url+'token-a',{headers:{cookie:cookies[0]}})).status,401);
    assert.equal((await fetch(url+'token-a',{headers:{cookie:cookies[1]}})).status,200);
  } finally { await new Promise(r=>server.close(r)); }
  const controller = require('../src/controllers/master.controller');
  const masterService = require('../src/services/master.service');
  const topupService = require('../src/services/topup.service');
  const otp = require('../src/services/otp.service');
  const master = { id: 1, master_token: 'token-a' };
  masterService.getMasterByPhone = async () => master;
  otp.verifyCode = async () => true;
  otp.clearVerified = async () => {};
  let loginCookie;
  const response = { set(){}, clearCookie(){this.cleared=true;}, redirect(path){this.redirected=path;}, render(view,data){this.data=data;}, json(data){this.data=data;}, cookie(name,value){loginCookie=value;} };
  await controller.loginVerify({body:{phone:'+995500000000',code:'1234'},cookies:{},headers:{},lang:'ru'},response);
  assert.equal(response.data.link,'/master');
  assert.equal(await session.token({cookies:{master_session:loginCookie}}),'token-a');
  await controller.logout({cookies:{master_session:loginCookie}},response);
  assert.equal(response.redirected,'/master');
  assert.ok(response.cleared);
  assert.equal(await session.token({cookies:{master_session:loginCookie}}),null);
  topupService.getDetails = async () => { throw Error('Payment service unavailable'); };
  await controller.statusPage({cookies:{},params:{},lang:'ru'},response);
  assert.equal(response.data.master,null);
  for (const lang of ['ru','en','ka']) for (const state of ['guest','pending','active','banned']) {
    const master = state === 'guest' ? null : {id:1,name:'Test',phone:'+995500000000',master_token:'token-a',balance_tetri:0,is_active:state==='active',is_banned:state==='banned',created_at:new Date(),category:'movers'};
    const html=await ejs.renderFile(__dirname+'/../src/views/master-status.ejs', {
      lang,t:translate(lang),clientStrings:clientStrings(lang),currentPath:'/master',master,badToken:false,
      reviews:[],activity:{},history:[],leads:[],supportMessages:[],receipts:[],topups:[],leadPriceTetri:50,catalogCallPriceTetri:50,payment:{},botUsername:'test'
    });
    for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(match[1].trim()) new vm.Script(match[1]);
    if(master) { assert.ok(html.indexOf('data-logout')<html.indexOf('<main')); assert.ok(html.includes('data-tab="leads" class="space-y-3"')); }
    else assert.ok(html.includes('id="loginPhone"'));
  }
  console.log('PASS: revoked session rejected, other device preserved, URL/legacy cookie cannot authenticate; cabinet rendered and scripts parsed in 3 languages and 4 account states.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>redis.disconnect());
