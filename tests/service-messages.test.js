const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Redis = require('ioredis-mock');
const db = require('pg-mem').newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const {Pool} = db.adapters.createPg();
const pool = new Pool(), redis = new Redis(), sent = [];
require.cache[require.resolve('../src/config/db')] = {exports: pool};
require.cache[require.resolve('../src/config/redis')] = {exports: redis};
require.cache[require.resolve('../src/services/consentLog.service')] = {exports: {recordOtpSent: async () => {}}};
require.cache[require.resolve('../src/services/sms.service')] = {exports: {
  sendOtp: async (phone, code, context) => {sent.push({phone,code,context});return {};},
  sendOrderNotification: async (phone, body) => {sent.push({phone,body});return {};},
}};
const otp = require('../src/services/otp.service');
const orders = require('../src/services/order.service');
const message = require('../src/config/service-message-copy');
(async () => {
  for (const [i,lang] of ['ru','en','ka'].entries()) {
    const phone = '+99550000010' + i;
    await otp.sendCode(phone, null, 'master_login', null, {language:lang});
    assert.equal(sent.at(-1).context.language, lang);
    const link = 'https://example.test/o/test';
    await otp.sendCode(phone, link, 'order', i+1, {language:'en',consent:{language:lang}});
    const code = await redis.get('otp:order:' + phone);
    assert.equal(sent.at(-1).body,message('orderCode',lang,{code,reference:' #'+(i+1),link}));
    assert.ok(!sent.at(-1).body.includes('{'));
    assert.ok(message('reviewInvite',lang,{id:1,link}).includes(link));
  }
  // Telegram prompts to a provider follow the Telegram app language until a profile with its own language is linked.
  assert.equal(message.telegramLanguage({language_code: 'ka'}), 'ka');
  assert.equal(message.telegramLanguage({language_code: 'en-GB'}), 'en');
  assert.equal(message.telegramLanguage({language_code: 'uk'}), 'ru');
  assert.equal(message.telegramLanguage(undefined), 'ru');
  for (const lang of ['ru', 'en', 'ka']) {
    const button = message('tgContactButton', lang);
    assert.ok(message('tgOwnNumber', lang, {button}).includes(button));
    assert.ok(message('tgNotRegistered', lang, {link: 'https://example.test/join'}).includes('https://example.test/join'));
    for (const key of ['tgLinkPrompt', 'tgQuestionSent']) assert.ok(!message(key, lang).includes('{'));
    assert.equal(message('nameRequired', lang).includes('{'), false);
  }
  // A moderator's or browser's current language must not replace recorded consent language.
  const log = (await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,consent_language) VALUES('CONSENT_VERIFIED','+995500000100','ru') RETURNING id")).rows[0];
  await pool.query("INSERT INTO consent_uses(consent_log_id,subject_role,subject_id) VALUES($1,'client',123)",[log.id]);
  assert.equal(await orders.getCustomerLanguage({id:123},'en'),'ru');
  assert.equal(await orders.getCustomerLanguage({id:999},'en'),'en');
  assert.equal(await orders.getCustomerLanguage({id:999},'invalid'),'ka');
  console.log('PASS: OTP language and consent precedence, code/link preservation, recorded customer language and legacy fallback. No real SMS sent.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>redis.disconnect());
