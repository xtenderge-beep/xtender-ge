// Отчёт после рассылки по каждому исполнителю: кому ушло, кто открыл ссылку, кто нажал «Позвонить»
// или WhatsApp — на экране заявки (менеджер, админка) и в отчёте по кнопке в Telegram.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
stub('../src/services/sms.service',{sendOrderNotification:async()=>({ok:true,providerMessageId:'test'})});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false});
const masters=require('../src/services/master.service'),report=require('../src/services/recipientReport.service'),dispatch=require('../src/services/dispatch.service');
let seq=0;
const provider=async name=>(await masters.registerMaster({name,phone:'+99550000700'+(++seq),serviceType:null})).id;
// Время по Тбилиси (UTC+4): 10:02 UTC — 14:02.
const at=clock=>'2026-10-14T'+clock+':00Z';
(async()=>{
  const order=(await pool.query("INSERT INTO orders(token,phone,description,status,target_categories,first_dispatched_at) VALUES('report-1','+995500007999','Переезд, диван и шкаф','new',$1,NOW()) RETURNING *",[['transport','movers']])).rows[0];
  const [called,opened,silent,lost,both,late,old,stranger]=await Promise.all(['Позвонил','Открыл','Молчит','Не дошло','Две отправки','Опоздал','Старая рассылка','Чужой'].map(provider));
  const run=async()=>(await pool.query('INSERT INTO dispatch_runs(order_id,category) VALUES($1,$2) RETURNING id',[order.id,'transport'])).rows[0].id;
  const first=await run(),second=await run();
  const deliver=(runId,id,status,channel,clock,reason=null)=>pool.query('INSERT INTO dispatch_deliveries(run_id,order_id,master_id,status,channel,reason,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[runId,order.id,id,status,channel,reason,clock?at(clock):null]);
  await deliver(first,called,'accepted','telegram','10:02');
  await deliver(first,opened,'accepted','sms','10:02');
  await deliver(first,silent,'accepted','sms','10:02');
  await deliver(first,lost,'failed','sms','10:02','channel_rejected');
  await deliver(first,late,'accepted','telegram','10:02');
  // Первая отправка не дошла, вторая дошла: в отчёте одна строка — «получил».
  await deliver(first,both,'failed','sms','10:02','channel_rejected');
  await deliver(second,both,'accepted','telegram','11:30');
  // Рассылка до журнала доставки: получателя видно только по списанию.
  await pool.query("INSERT INTO balance_transactions(master_id,amount_tetri,reason,order_id,created_at) VALUES($1,-50,'lead_charge',$2,$3)",[old,order.id,at('09:00')]);
  const event=(id,type,clock)=>pool.query('INSERT INTO order_views(order_id,master_id,event_type,viewed_at) VALUES($1,$2,$3,$4)',[order.id,id,type,at(clock)]);
  // Нажатие на закрытой заявке — через настоящую выдачу номера (orderContact.service), не ручной записью.
  // Без услуг approveMaster не одобряет — активным делаем напрямую, иначе выдача номера ответит forbidden.
  await pool.query("UPDATE masters SET master_token='late-token', is_active=true WHERE id=$1",[late]);
  const closed=(await pool.query("INSERT INTO orders(token,phone,description,status,target_categories) VALUES('report-2','+995500007998','Стиральная машина','closed',$1) RETURNING *",[['transport']])).rows[0];
  await pool.query("INSERT INTO balance_transactions(master_id,amount_tetri,reason,order_id) VALUES($1,-50,'lead_charge',$2)",[late,closed.id]);
  assert.deepEqual(await require('../src/services/orderContact.service').reveal('report-2','late-token','whatsapp',{},'link'),{status:409,code:'unavailable'});
  const closedReport=await report.build(closed.id);
  assert.deepEqual([closedReport.rows[0].name,closedReport.rows[0].denied.whatsapp?.reason,closedReport.rows[0].whatsapp,closedReport.summary.denied],['Опоздал','unavailable',null,1]);
  await event(called,'view','10:05');await event(called,'call','10:07');await event(called,'whatsapp','12:10');
  await event(opened,'view','10:20');
  await event(both,'view','11:31');await event(both,'whatsapp','11:32');
  await event(late,'view','10:40');
  await event(stranger,'view','10:50');
  // Нажал «Позвонить», когда заявка уже закрылась: номер не выдан, но нажатие видно.
  const denied=(id,channel,reason,clock)=>pool.query("INSERT INTO sms_consent_logs(event_type,phone_number,master_id,order_id,metadata,timestamp_utc) VALUES('ORDER_CONTACT_DENIED','+995500007999',$1,$2,$3,$4)",[id,order.id,JSON.stringify({channel,reason}),at(clock)]);
  await denied(late,'call','unavailable','10:41');
  await denied(stranger,'whatsapp','forbidden','10:51');

  // Баланс получателя: у «Позвонил» хватает на следующую заявку, у остальных 0 — помечены.
  await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[called]);
  const built=await report.build(order.id),row=id=>built.rows.find(r=>r.master_id===id);
  assert.deepEqual([row(called).balance_tetri,row(called).low,row(silent).balance_tetri,row(silent).low],[5000,false,0,true]);
  assert.equal(built.rows.length,8,'один исполнитель — одна строка');
  assert.deepEqual(built.rows.map(r=>r.name),['Позвонил','Открыл','Опоздал','Две отправки','Старая рассылка','Молчит','Не дошло','Чужой'],'сначала открывшие — кто раньше открыл, тот выше; потом не открывшие по времени доставки; в конце не получившие');
  assert.deepEqual(built.summary,{received:6,opened:4,contacted:2,call:1,whatsapp:2,notOpened:2,pending:0,failed:1,denied:1,outside:1});
  assert.deepEqual([row(both).status,row(both).channel,new Date(row(both).sent_at).toISOString()],['accepted','telegram',at('11:30').replace('Z','.000Z')]);
  assert.deepEqual([row(old).outcome,row(old).channel,row(lost).outcome,row(lost).reason,row(stranger).outcome],['not_opened',null,'not_delivered','channel_rejected','outside']);
  assert.deepEqual(row(late).denied.call.reason,'unavailable');
  assert.equal(row(late).outcome,'opened','нажатие без выданного номера — не контакт');

  // Время по Тбилиси, у событий того же дня — только часы.
  assert.equal(report.when(at('10:02')),'14.10 14:02');
  assert.equal(report.when(at('10:05'),at('10:02')),'14:05');
  assert.equal(report.when('2026-10-15T06:00:00Z',at('10:02')),'15.10 10:00');
  assert.deepEqual([report.after(at('10:02'),at('10:02')),report.after(at('10:02'),at('10:05')),report.after(at('10:02'),at('12:10')),report.after(at('10:02'),'2026-10-16T10:02:00Z'),report.after(null,at('10:05'))],
    ['меньше чем через минуту','через 3 мин','через 2 ч 8 мин','через 2 дн','']);

  // Строки Telegram: имя, канал и время доставки, открытие с задержкой, нажатия, баланс.
  assert.equal(report.recipientLine(row(called)),'✅ Позвонил · Telegram 14.10 14:02 · открыл 14:05 (через 3 мин) · 📞 14:07 · 💬 16:10 · баланс 50.00 ₾');
  assert.equal(report.recipientLine(row(silent)),'▫️ Молчит · SMS 14.10 14:02 · не открыл · баланс 0.00 ₾ ❗');
  assert.equal(report.recipientLine(row(lost)),'⚠️ Не дошло · не доставлено (канал отклонил отправку) · баланс 0.00 ₾ ❗');
  assert.equal(report.recipientLine(row(late)),'👀 Опоздал · Telegram 14.10 14:02 · открыл 14:40 (через 38 мин) · 📞 нажал 14:41, номер не выдан · баланс 0.00 ₾ ❗');
  assert.equal(report.recipientLine(row(stranger)),'🚫 Чужой · не был в рассылке · открыл 14.10 14:50 · 💬 нажал 14.10 14:51, номер не выдан · баланс 0.00 ₾ ❗');
  const runs=await require('../src/services/order.service').getOrderDispatches(order.id);
  const text=report.telegramText({order,runs,report:built,labels:{transport:'Перевозки'}});
  assert.match(text,/^Заявка #\d+ · кто получил и что сделал\nПолучили 6 · открыли ссылку 4 · нажали контакт 2 \(📞 1, 💬 2\) · не открыли 2 · не доставлено 1\n/);
  assert.match(text,/Перевозки #\d+: выбрано 6, принято 4, ошибки 2/);
  assert.ok(!text.includes('+9955'),'телефонов в отчёте нет');
  assert.equal(report.telegramText({order,runs:[],report:{rows:[],summary:built.summary}}),'Заявка #'+order.id+' · кто получил и что сделал\nРассылок ещё нет.');

  // Экран заявки: таблица по исполнителям у менеджера (без ссылок на карточки) и у администратора.
  const screen=await dispatch.screen(order.token);
  assert.equal(screen.report.rows.length,8);
  const ejs=require('ejs'),view=path.join(__dirname,'../src/views/partials/order-screen.ejs');
  const render=masterHref=>ejs.renderFile(view,{...screen,base:'/manager/orders/'+order.token,listHref:'/manager/orders',csrf:'x',canCloseNeed:false,masterHref,result:null,error:null,date:v=>v?new Date(v).toISOString():'—'});
  const page=await render('');
  assert.match(page,/Получили: <strong>6<\/strong> · открыли ссылку: <strong>4<\/strong> · нажали контакт: <strong>2<\/strong> \(позвонить 1, WhatsApp 2\) · не открыли: <strong>2<\/strong> · не доставлено: <strong>1<\/strong>/);
  assert.match(page,/<tr class="is-contacted">\s*<td data-label="Исполнитель">Позвонил<span class="balance">баланс 50\.00 ₾<\/span><span class="balance">за 30 дней заявок не получал<\/span><\/td>\s*<td data-label="Получил" class="">Telegram · 14\.10 14:02<\/td>\s*<td data-label="Открыл ссылку" class="yes">✓ 14:05 · через 3 мин<\/td>\s*<td data-label="Позвонить" class="yes">✓ 14:07 · через 5 мин<\/td>\s*<td data-label="WhatsApp" class="yes">✓ 16:10 · через 2 ч 8 мин<\/td><\/tr>/);
  assert.match(page,/Молчит<span class="balance bad">баланс 0\.00 ₾ — не хватит на следующую заявку<\/span><span class="balance">за 30 дней заявок не получал<\/span><\/td>\s*<td[^>]*>SMS · 14\.10 14:02<\/td>\s*<td data-label="Открыл ссылку" class="no">не открыл<\/td>/);
  // Под именем баланс и история за 30 дней (историю с датами от сегодняшнего дня проверяет dispatch-newcomers).
  const name=who=>who+'(?:<span[^>]*>[^<]*<\\/span>)+<\\/td>';
  assert.match(page,new RegExp(name('Опоздал')+'[\\s\\S]*?<td data-label="Позвонить" class="bad">нажал 14:41 — номер не выдан: заявка или услуга уже закрыта<\\/td>'));
  assert.match(page,new RegExp(name('Не дошло')+'\\s*<td data-label="Получил" class="bad">не доставлено · канал отклонил отправку<\\/td>\\s*<td data-label="Открыл ссылку" class="no">—<\\/td>'));
  assert.match(page,new RegExp(name('Чужой')+'\\s*<td data-label="Получил" class="bad">не был в рассылке<\\/td>'));
  assert.match(page,new RegExp(name('Старая рассылка')+'\\s*<td data-label="Получил" class="">14\\.10 13:00<\\/td>'),'старая рассылка без канала');
  assert.match(await render('/admin/masters/'),new RegExp('<a href="/admin/masters/'+called+'">Позвонил</a>'));
  console.log('PASS: recipient report — per provider: delivered, opened link, call / WhatsApp with times; screen table and Telegram text');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
