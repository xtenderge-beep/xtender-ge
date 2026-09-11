const assert = require('node:assert/strict');
const express = require('express');
const ejs = require('ejs');
const path = require('path');
const {change,returnPath} = require('../src/controllers/language.controller');

(async()=>{
  for(const target of ['/master/demo#balance','/master/demo/topups/1','/order/demo?master=42#details']) assert.equal(returnPath(target),target);
  for(const target of ['https://example.com','//example.com','/\\example.com','/lang/ru',undefined,['/master/demo'],'/\nexample.com']) assert.equal(returnPath(target),'/');
  const html=await ejs.renderFile(path.join(__dirname,'../src/views/partials/lang-switch.ejs'),{lang:'ru',currentPath:'/master/demo/topups/1'});
  assert.ok(html.includes('/lang/en?next=%2Fmaster%2Fdemo%2Ftopups%2F1'));
  const publicHtml=await ejs.renderFile(path.join(__dirname,'../src/views/partials/lang-switch.ejs'),{lang:'ru',alternates:{ru:'/ru/join',ka:'/join',en:'/en/join'}});
  assert.ok(publicHtml.includes('/join?lang=ka'));assert.ok(!publicHtml.includes('?next='));
  const app=express();app.get('/lang/:code',change);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  try {
    const base='http://127.0.0.1:'+server.address().port;
    for(const lang of ['ka','ru','en']) {
      const target='/master/demo?source=test#balance';
      const response=await fetch(base+'/lang/'+lang+'?next='+encodeURIComponent(target),{redirect:'manual'});
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),target);
      assert.ok(response.headers.get('set-cookie').startsWith('lang='+lang+';'));
    }
    const response=await fetch(base+'/lang/en?next=https://example.com',{redirect:'manual',headers:{Referer:'https://example.com'}});
    assert.equal(response.headers.get('location'),'/');
  } finally { await new Promise(resolve=>server.close(resolve)); }
  console.log('PASS: language redirect without Referer, three locales, tab/query preservation, public URLs and unsafe redirect rejection.');
})().catch(error=>{console.error(error);process.exitCode=1;});
