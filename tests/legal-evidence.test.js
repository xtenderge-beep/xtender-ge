// Доказательства в журнале согласий: настоящий адрес клиента за двумя прокси, текст и категория каждой SMS без
// секретов, история смены номера, вернуть в рассылку можно только при согласии на заявки, проверяемая цепочка
// отпечатков журнала с суточным отпечатком в Telegram.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
const redis=new(require('ioredis-mock'))();
stub('../src/config/db',pool);stub('../src/config/redis',redis);
const alerts=[];
stub('../src/services/telegram.service',{sendSecurityAlert:async text=>{alerts.push(text);},updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{}});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
const {clientIp,requestMeta}=require('../src/config/requestMeta');
const consentLog=require('../src/services/consentLog.service'),sms=require('../src/services/sms.service'),otp=require('../src/services/otp.service');
const masters=require('../src/services/master.service'),subscription=require('../src/services/leadSubscription.service');
const permissions=require('../src/services/smsPermissions.service'),gate=require('../src/services/leadSmsConsent.service');
const chain=require('../src/services/consentChain.service');
const json=value=>typeof value==='string' ? JSON.parse(value) : value;
const rows=async(type)=>(await pool.query('SELECT * FROM sms_consent_logs WHERE event_type=$1 ORDER BY id',[type])).rows;
let seq=0;
async function provider(name) {
  const m=await masters.registerMaster({name,phone:'+99550000870'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  return (await pool.query('SELECT * FROM masters WHERE id=$1',[m.id])).rows[0];
}
const originalLog=console.log;
(async()=>{
  console.log=()=>{};
  // 1. Адрес клиента: второй справа в X-Forwarded-For; подделка левее не берётся; без заголовка — req.ip.
  const req=xff=>({ip:'10.0.0.1',headers:xff ? {'x-forwarded-for':xff} : {},get:()=> 'agent'});
  assert.equal(clientIp(req('91.151.1.1, 89.222.2.2')),'91.151.1.1');
  assert.equal(clientIp(req('6.6.6.6, 91.151.1.1, 89.222.2.2')),'91.151.1.1','адрес, дописанный клиентом, не берётся');
  assert.equal(clientIp(req('91.151.1.1')),'91.151.1.1');
  assert.equal(clientIp(req('')),'10.0.0.1');
  assert.deepEqual(requestMeta(req('91.151.1.1, 89.222.2.2')),{ip:'91.151.1.1',userAgent:'agent',xForwardedFor:'91.151.1.1, 89.222.2.2'});

  // 2. Текст и категория каждой SMS — без секретов: ключ личной ссылки, ссылки кабинета, заказчика, Stop, сам код.
  const lead='Xtender: Zakazi (Order) #42: https://xtender.ge/order/abc123?k=SECRETKEY_0123456789ab Stop: https://xtender.ge/stop/StopCode1';
  await sms.sendOrderNotification('+995500008801',lead,{kind:'lead',masterId:null,orderId:null});
  await sms.sendOrderNotification('+995500008801','Xtender: balance 0.50 GEL. Top up: https://xtender.ge/master/CABINETTOKEN',{category:'balance'});
  await sms.sendOrderNotification('+995500008801','Xtender: request #42 is sent. Status and closing: https://xtender.ge/o/OWNERTOKEN99');
  // Журнал доставки и отправки кода пишется в фоне, чтобы не задерживать SMS: ждём, пока строки появятся.
  const arrive=async(type,count)=>{for(let i=0;i<100 && (await rows(type)).length<count;i++) await new Promise(resolve=>setTimeout(resolve,50));};
  await arrive('LEAD_SMS_SENT',1);await arrive('TX_SMS_SENT',2);
  const [leadRow]=await rows('LEAD_SMS_SENT');
  assert.deepEqual([json(leadRow.metadata).category,json(leadRow.metadata).message_text],['lead','Xtender: Zakazi (Order) #42: https://xtender.ge/order/abc123?k=[скрыто] Stop: https://xtender.ge/stop/[скрыто]']);
  const tx=await rows('TX_SMS_SENT');
  // Журнал доставки пишется в фоне: порядок двух почти одновременных SMS не гарантирован.
  assert.deepEqual(tx.map(r=>[json(r.metadata).category,json(r.metadata).message_text]).sort(),[
    ['balance','Xtender: balance 0.50 GEL. Top up: https://xtender.ge/master/[скрыто]'],
    ['service','Xtender: request #42 is sent. Status and closing: https://xtender.ge/o/[скрыто]'],
  ]);
  for (const row of [leadRow,...tx]) assert.ok(!JSON.stringify(row).includes('SECRETKEY') && !JSON.stringify(row).includes('CABINETTOKEN') && !JSON.stringify(row).includes('OWNERTOKEN'),'секретов нет нигде в строке');
  assert.equal(leadRow.message_body_hash.length,64,'хэш полного текста сохраняется для сверки');
  const sent=await otp.sendCode('+995500008802','master_login',null,{});
  assert.equal(sent.success,true);
  const code=await redis.get('otp:master_login:+995500008802');
  await arrive('SMS_OTP_SENT',1);
  const otpRow=(await rows('SMS_OTP_SENT')).at(-1);
  assert.deepEqual([json(otpRow.metadata).category,json(otpRow.metadata).message_text],['code','Code: [код]']);
  assert.ok(!JSON.stringify(otpRow.metadata).includes(code));

  // 3. История номера: смена номера администратором — запись на новом номере и на старом; тот же номер — ничего.
  const giorgi=await provider('Гиорги');
  const before=(await rows('PHONE_CHANGED')).length;
  await masters.updateMasterProfile(giorgi.id,{name:giorgi.name,phone:giorgi.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru'],changedBy:'admin'});
  assert.equal((await rows('PHONE_CHANGED')).length,before,'номер не менялся');
  await masters.updateMasterProfile(giorgi.id,{name:giorgi.name,phone:'+995599111222',services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru'],changedBy:'admin',meta:{ip:'91.151.1.1'}});
  const changed=(await rows('PHONE_CHANGED')).at(-1),replaced=(await rows('PHONE_REPLACED')).at(-1);
  assert.deepEqual([changed.phone_number,json(changed.metadata).old_phone,json(changed.metadata).actor,changed.ip_address],['+995599111222',giorgi.phone,'admin','91.151.1.1']);
  assert.deepEqual([replaced.phone_number,json(replaced.metadata).new_phone,Number(replaced.master_id)],[giorgi.phone,'+995599111222',Number(giorgi.id)]);

  // 4. Вернуть в рассылку администратор может только при согласии на заявки на этот номер.
  const levan=await provider('Леван');
  await pool.query('UPDATE masters SET is_subscribed=false WHERE id=$1',[levan.id]);
  assert.equal(await subscription.setByAdmin(levan.id,true),'no_consent','без согласия на заявки — нельзя');
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,channel,metadata) VALUES('CONSENT_SMS_OTP_VERIFIED',$1,'sms',$2)",[levan.phone,JSON.stringify({snapshot:{choices:{lead_sms:false,marketing_sms:true}}})]);
  assert.equal(await subscription.setByAdmin(levan.id,true),'no_consent','при регистрации отметку заявок не ставил');
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,channel,metadata) VALUES('CONSENT_SMS_OTP_VERIFIED',$1,'sms',$2)",[levan.phone,JSON.stringify({snapshot:{language:'ru'}})]);
  assert.equal(await subscription.setByAdmin(levan.id,true),true,'прежняя единая отметка включала сообщения о заявках');
  const nino=await provider('Нино');
  await pool.query('UPDATE masters SET is_subscribed=false WHERE id=$1',[nino.id]);
  assert.equal(await subscription.set(nino.id,true,{source:'cabinet',language:'ru'}),true,'сам исполнитель включает с текстом');
  assert.equal(await permissions.hasLeadConsent(nino.id),true);
  await gate.setRequired(true);
  const consented=await gate.gate();
  assert.equal(consented(await masters.getMasterByToken(nino.master_token)),true,'включение с текстом — запись согласия для проверки перед рассылкой');
  await gate.setRequired(false);
  assert.equal(await subscription.setByAdmin(999999,true),null);

  // 5. Цепочка отпечатков: все записи в цепочке, проверка проходит, отпечаток дня уходит в Telegram.
  process.env.TELEGRAM_MODERATOR_CHAT_ID='test-chat';
  const total=Number((await pool.query('SELECT COUNT(*)::int AS n FROM sms_consent_logs')).rows[0].n);
  assert.equal(await chain.extend({settleMs:-1000}),total);
  assert.equal(await chain.extend({settleMs:-1000}),0,'повторно ничего не добавляется');
  let check=await chain.verify();
  assert.deepEqual([check.ok,check.checked,check.unchained],[true,total,0]);
  const anchored=await chain.anchor();
  assert.ok(alerts.at(-1).includes(anchored.head) && alerts.at(-1).includes('записей '+total),'отпечаток ушёл в Telegram');
  assert.deepEqual((await chain.status()).chained,total);
  check=await chain.verify();
  assert.deepEqual([check.ok,check.anchors],[true,1]);
  // Новая запись продолжает цепочку.
  await consentLog.recordAction({eventType:'LEAD_SMS_OPT_OUT',phone:nino.phone,masterId:nino.id,metadata:{actor:'provider',source:'cabinet'}});
  assert.equal(await chain.extend({settleMs:-1000}),1);
  assert.equal((await chain.verify()).ok,true);
  // Изменённая и удалённая записи ломают цепочку (на настоящей базе это возможно только сняв защиту журнала).
  const victim=(await pool.query("SELECT id FROM sms_consent_logs WHERE event_type='PHONE_CHANGED' ORDER BY id LIMIT 1")).rows[0].id;
  await pool.query("UPDATE sms_consent_logs SET phone_number='+995500000000' WHERE id=$1",[victim]);
  check=await chain.verify();
  assert.equal(check.ok,false);
  assert.deepEqual(check.problems.map(p=>[p.log_id,p.problem]),[[Number(victim),'запись журнала изменена']]);
  const gone=(await pool.query("SELECT id FROM sms_consent_logs WHERE event_type='PHONE_REPLACED' ORDER BY id LIMIT 1")).rows[0].id;
  await pool.query('DELETE FROM sms_consent_logs WHERE id=$1',[gone]);
  check=await chain.verify();
  assert.ok(check.problems.some(p=>p.log_id===Number(gone) && p.problem==='запись журнала удалена'));

  console.log=originalLog;
  console.log('legal-evidence.test.js: OK');
  process.exit(0);
})().catch(error=>{console.log=originalLog;console.error(error);process.exit(1);});
