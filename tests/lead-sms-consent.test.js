// «Заявки только с согласием» (leadSmsConsent.service): выключенный переключатель ничего не меняет; включённый
// оставляет в рассылке только исполнителей с записью согласия на их номер, в том числе в заранее подготовленном
// списке. Экран согласий показывает, у кого записи нет и почему. Отказ от заявок и возврат пишутся в журнал
// согласий, который не удаляется вместе с профилем.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);stub('../src/config/redis',new(require('ioredis-mock'))());
const sms=[];
stub('../src/services/sms.service',{sendOrderNotification:async(phone,text,context)=>{sms.push({phone,kind:context?.kind});return {ok:true,providerMessageId:'test'};}});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false,notifyModerator:async()=>{}});
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service'),orders=require('../src/services/order.service');
const gate=require('../src/services/leadSmsConsent.service'),subscription=require('../src/services/leadSubscription.service');
const admin=require('../src/controllers/admin.controller');
let seq=0;
async function provider(name) {
  const m=await masters.registerMaster({name,phone:'+99550000840'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services:[{type:'movers',attributes:{crew_size:2}}],cityIds:[1],spokenLanguages:['ru']});
  await masters.approveMaster(m.id);
  await pool.query("UPDATE masters SET language='ru' WHERE id=$1",[m.id]);
  return (await pool.query('SELECT * FROM masters WHERE id=$1',[m.id])).rows[0];
}
const newOrder=(token,description)=>pool.query("INSERT INTO orders(token,owner_token,phone,description,status,target_categories) VALUES($1,$2,'+995500008999',$3,'pending_review',$4) RETURNING *",[token,token+'-owner',description,[]]).then(r=>r.rows[0]);
const leadsTo=master=>sms.filter(s=>s.kind==='lead' && s.phone===master.phone).length;
const json=value=>typeof value==='string' ? JSON.parse(value) : value;
const journal=async id=>(await pool.query("SELECT event_type, phone_number, order_id, ip_address, metadata FROM sms_consent_logs WHERE master_id=$1 AND event_type LIKE 'LEAD_SMS_OPT_%' ORDER BY id",[id])).rows;
(async()=>{
  const consented=await provider('С согласием'),unconsented=await provider('Без согласия');
  // Оба заведены до журнала. Первый потом прошёл регистрацию с кодом; его согласие записано в другом формате номера.
  await pool.query("UPDATE masters SET created_at='2026-08-01T00:00:00Z' WHERE id IN ($1,$2)",[consented.id,unconsented.id]);
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,channel,terms_version,timestamp_utc) VALUES('CONSENT_SMS_OTP_VERIFIED',$1,'sms','v1.6','2026-09-03T10:00:00Z')",[consented.phone.slice(1)]);
  // Согласие заказчика на номер второго исполнителя — не согласие исполнителя на заявки.
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,channel) VALUES('CLIENT_CONSENT_OTP_VERIFIED',$1,'sms')",[unconsented.phone]);

  // По умолчанию выключено: рассылка как раньше, заявку получают оба.
  assert.equal(await gate.isRequired(),false);
  const first=await newOrder('gate-1','Перенести диван');
  assert.equal((await dispatch.sendNeeds(first.token,{needs:['movers']},null,'',{actor:'test'})).count,2);

  // Ещё двое после начала журнала: один заведён без кода, другой регистрировался с кодом, а номер потом сменили.
  const noCode=await provider('Без кода'),changed=await provider('Сменил номер');
  await pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,master_id,channel) VALUES('MASTER_REGISTERED','+995599000111',$1,'web')",[changed.id]);
  await pool.query('UPDATE masters SET telegram_id=777 WHERE id=$1',[consented.id]);

  // Экран согласий: сколько подписаны на заявки, у кого есть запись (по версиям текста), у кого нет и почему.
  const page={render(view,data){this.view=view;this.data=data;}};
  await admin.consentLog({query:{}},page);
  assert.equal(page.view,'admin/consent');
  const view=page.data.leadGate;
  assert.deepEqual([view.required,view.total,view.telegram,view.consented],[false,4,1,1]);
  assert.deepEqual(view.versions,[{version:'v1.6',count:1}]);
  assert.deepEqual(view.missing.map(m=>[m.id,m.reason]),[[unconsented.id,'before_journal'],[noCode.id,'no_code'],[changed.id,'phone_changed']]);
  assert.deepEqual(view.reasons.map(r=>[r.key,r.count]),[['phone_changed',1],['before_journal',1],['no_code',1]]);
  const markup=await ejs.renderFile(path.join(__dirname,'../src/views/admin/consent.ejs'),{phoneQuery:'',report:null,recent:[],csrfToken:'test',leadGate:view});
  for (const text of ['Подписаны на заявки: <b>4</b>','из них с Telegram: 1','С записью согласия: <b>1</b>','v1.6 — 1','Без записи согласия: <b>3</b>',
    gate.REASONS.phone_changed+' — 1',gate.REASONS.before_journal+' — 1',gate.REASONS.no_code+' — 1','action="/admin/consent/lead-gate"','name="enabled" value="1"'])
    assert.ok(markup.includes(text),text);
  await admin.consentLog({query:{phone:consented.phone}},page);
  assert.equal(page.data.leadGate,null,'в карточке номера блока нет');

  // Включили: новую заявку получает только исполнитель с записью согласия.
  const back={redirect(url){this.url=url;}};
  await admin.updateLeadGate({body:{enabled:'1'}},back);
  assert.equal(back.url,'/admin/consent#lead-gate');
  assert.equal(await gate.isRequired(),true);
  const second=await newOrder('gate-2','Поднять шкаф на 5 этаж');
  const [withBefore,withoutBefore]=[leadsTo(consented),leadsTo(unconsented)];
  assert.equal((await dispatch.sendNeeds(second.token,{needs:['movers']},null,'',{actor:'test'})).count,1);
  assert.equal(leadsTo(consented),withBefore+1);
  assert.equal(leadsTo(unconsented),withoutBefore,'без записи согласия заявка не уходит');
  assert.equal(leadsTo(noCode)+leadsTo(changed),0);

  // Список, подготовленный заранее (повтор отправки), проверяется в момент отправки.
  const third=await newOrder('gate-3','Вынести старую мебель');
  const run=(await pool.query("INSERT INTO dispatch_runs(order_id,category,vehicle_size,language,initiated_by,revision) VALUES($1,'movers','','','test',0) RETURNING *",[third.id])).rows[0];
  await pool.query("INSERT INTO dispatch_deliveries(run_id,order_id,master_id,matched_categories,service_snapshot) VALUES($1,$2,$3,'[]'::jsonb,'[]'::jsonb)",[run.id,third.id,unconsented.id]);
  assert.equal(await orders.notifyMasters(third,'movers',null,null,'',{preparedRun:run,recipientIds:[unconsented.id],actor:'test'}),0);
  assert.deepEqual((await pool.query('SELECT status, reason FROM dispatch_deliveries WHERE run_id=$1 AND master_id=$2',[run.id,unconsented.id])).rows[0],{status:'skipped',reason:'no_consent'});
  assert.equal(leadsTo(unconsented),withoutBefore);

  // Выключили: снова как раньше.
  await admin.updateLeadGate({body:{enabled:'0'}},back);
  assert.equal(await gate.isRequired(),false);

  // Отказ от заявок и возврат — в журнале согласий: откуда, с какого адреса, по какой заявке. Повтор не пишется.
  const meta={ip:'203.0.113.5',userAgent:'test-agent',xForwardedFor:'203.0.113.5'};
  assert.equal(await subscription.set(consented.id,false,{source:'order',orderToken:second.token,orderId:second.id,meta}),false);
  assert.equal(await subscription.set(consented.id,false,{source:'order',orderToken:second.token,orderId:second.id,meta}),false);
  assert.equal(await subscription.set(consented.id,true,{source:'cabinet',meta}),true);
  assert.equal(await subscription.setByAdmin(consented.id,false),false);
  const rows=await journal(consented.id);
  assert.deepEqual(rows.map(r=>[r.event_type,r.order_id===null ? null : Number(r.order_id),json(r.metadata).actor,json(r.metadata).source]),[
    ['LEAD_SMS_OPT_OUT',Number(second.id),'provider','order'],
    ['LEAD_SMS_OPT_IN',null,'provider','cabinet'],
    ['LEAD_SMS_OPT_OUT',null,'admin','admin'],
  ]);
  assert.deepEqual([rows[0].phone_number,rows[0].ip_address],[consented.phone,'203.0.113.5']);
  assert.equal(await subscription.set(999999,false),null);

  console.log('lead-sms-consent.test.js: OK');
  process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
