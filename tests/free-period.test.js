// Бесплатный период: исполнитель без платного режима (masters.paid_mode = false, так по умолчанию)
// получает заявки и открывает номер в каталоге без списаний, без подтверждённых тарифов и при любом
// балансе. Платный режим включает администратор — с этого момента действуют прежние правила.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(name,exports)=>require.cache[require.resolve(name)]={exports};
stub('../src/config/db',pool);stub('../src/config/redis',new(require('ioredis-mock'))());
let sent=[];stub('../src/services/sms.service',{sendOrderNotification:async(phone,text)=>{sent.push({phone,text});return {ok:true,providerMessageId:'test'};}});
stub('../src/services/telegram.service',{sendLeadToMaster:async()=>false,sendToChat:async()=>{},notifyModerator:async()=>{},updateMessage:async()=>{}});
const billing=require('../src/services/providerBilling.service');
const orders=require('../src/services/order.service'),masters=require('../src/services/master.service');
const admin=require('../src/services/admin.service'),contact=require('../src/services/orderContact.service');
const {translate}=require('../src/config/i18n');
(async()=>{
 // Свои деньги на балансе, тарифы не подтверждены, денег меньше цены заявки — в платном режиме заявка не ушла бы.
 const master=(await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active,is_subscribed,balance_tetri) VALUES('Free','+995500000901','free-master','movers',true,true,20) RETURNING *")).rows[0];
 assert.equal(master.paid_mode,false,'new providers start in the free period');
 await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[master.id]);
 await pool.query("INSERT INTO balance_transactions(master_id,amount_tetri,reason) VALUES($1,20,'topup')",[master.id]);
 const balance=async()=>Number((await pool.query('SELECT balance_tetri FROM masters WHERE id=$1',[master.id])).rows[0].balance_tetri);
 const newOrder=async token=>(await pool.query("INSERT INTO orders(token,phone,description,status,target_categories) VALUES($1,'+995500000902','Move a piano','new',ARRAY['movers']) RETURNING *",[token])).rows[0];

 const state=await billing.state(master.id,'ru');
 assert.equal(state.free,true);assert.equal(state.required,false,'no rate confirmation is asked in the free period');

 // Заявка уходит, баланс не меняется; доставка записана нулевой строкой lead_charge и в журнал доказательств.
 assert.equal((await orders.getDispatchRecipients('movers',null,50)).length,1);
 const order=await newOrder('free-order-1');
 // Экран рассылки: получатель есть, сумма списания 0 — бесплатный получатель в неё не входит.
 const plan=await require('../src/services/dispatch.service').preview(order.token,'movers');
 assert.equal(plan.count,1);assert.equal(plan.charge,0);
 assert.equal(await orders.notifyMasters(order,'movers',null,50),1);assert.equal(sent.length,1);
 assert.equal(await balance(),20);
 const rows=(await pool.query("SELECT amount_tetri FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge'",[master.id,order.id])).rows;
 assert.deepEqual(rows.map(r=>Number(r.amount_tetri)),[0]);
 const evidence=(await pool.query("SELECT metadata FROM sms_consent_logs WHERE event_type='LEAD_CHARGE_ACCEPTED' AND master_id=$1",[master.id])).rows[0].metadata;
 assert.equal(evidence.amount_tetri,0);assert.equal(evidence.billing_basis,'free_period');assert.equal(evidence.balance_after_tetri,20);
 assert.equal(await orders.notifyMasters(order,'movers',null,50),0,'the same order is not sent twice');assert.equal(sent.length,1);
 assert.equal((await pool.query('SELECT missed_dispatch_count FROM masters WHERE id=$1',[master.id])).rows[0].missed_dispatch_count,0,'no «missed for low balance» in the free period');

 // Контакт заказчика открывается по бесплатной заявке.
 assert.equal((await contact.reveal(order.token,master.master_token,'call')).status,200);

 // Каталог: номер открывается без списания, карточка доступна.
 const card=(await masters.listMasters()).find(m=>m.id===master.id);assert.equal(card.paid_mode,false);
 const opened=await masters.revealPhoneForCall(master.id,50,'+995500000903');
 assert.ok(opened);assert.equal(opened.charged,false);assert.equal(opened.phone,master.phone);assert.equal(await balance(),20);
 assert.ok((await masters.revealPhoneForCall(master.id,50,'+995500000903')).alreadyOpened);
 assert.equal((await pool.query("SELECT id FROM balance_transactions WHERE master_id=$1 AND reason='catalog_call'",[master.id])).rows.length,0);

 // В истории баланса кабинета нулевых строк нет; в списке заявок заявка есть.
 assert.deepEqual((await masters.getMasterBalanceHistory(master.id)).map(h=>h.reason),['topup']);

 // Кабинет: крупно «Бесплатный период», баланс одной строкой, без «Пополните баланс» и кнопки баланса.
 const view=path.join(__dirname,'../src/views/partials/provider-overview.ejs');
 for(const lang of ['ka','ru','en']) {
   const t=translate(lang),html=await ejs.renderFile(view,{master:{...master,paid_mode:false},billingState:state,leadPriceTetri:50,t});
   assert.ok(html.includes('data-account-state="ready"'));assert.ok(html.includes(t('provider_free_title')));assert.ok(html.includes(t('provider_free_body')));
   assert.ok(html.includes(t('provider_free_balance').replace('{amount}','0.20')));assert.ok(!html.includes('provider-balance-row'));assert.ok(!html.includes(t('provider_balance_action')));
 }

 // Администратор включает платный режим: дальше — прежние правила (своих денег без подтверждения тарифов не списываем).
 assert.ok(await admin.setMasterPaidMode(master.id,true));
 const paid=(await pool.query('SELECT * FROM masters WHERE id=$1',[master.id])).rows[0];assert.equal(paid.paid_mode,true);
 assert.equal((await billing.state(master.id,'ru')).required,true);
 assert.equal((await orders.getDispatchRecipients('movers',null,50)).length,0);
 assert.equal(await orders.notifyMasters(await newOrder('free-order-2'),'movers',null,50),0);assert.equal(sent.length,1);
 assert.equal(await masters.revealPhoneForCall(master.id,50,'+995500000904'),null);assert.equal(await balance(),20);
 const t=translate('ru'),html=await ejs.renderFile(view,{master:paid,billingState:await billing.state(master.id,'ru'),leadPriceTetri:50,t});
 assert.ok(html.includes('data-account-state="billing_pending"'));assert.ok(!html.includes(t('provider_free_title')));assert.ok(html.includes('provider-balance-row'));

 // Вернули бесплатный режим — заявки снова уходят.
 assert.ok(await admin.setMasterPaidMode(master.id,false));
 assert.equal(await orders.notifyMasters(await newOrder('free-order-3'),'movers',null,50),1);assert.equal(await balance(),20);
 assert.equal(await admin.setMasterPaidMode(999999,true),null);

 // Смешанная рассылка: бесплатный и платный (подарочный баланс) — итог «списано» считает только платного.
 const paidOne=(await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active,is_subscribed,balance_tetri,paid_mode) VALUES('Paid','+995500000905','paid-master','movers',true,true,500,true) RETURNING *")).rows[0];
 await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)",[paidOne.id]);
 await pool.query("INSERT INTO balance_transactions(master_id,amount_tetri,reason,note) VALUES($1,500,'promo','WELCOME_AUTO')",[paidOne.id]);
 const mixed=await newOrder('free-order-4'),dispatch=require('../src/services/dispatch.service');
 const mixedPlan=await dispatch.preview(mixed.token,'movers');assert.equal(mixedPlan.count,2);assert.equal(mixedPlan.charge,50);
 const done=await dispatch.dispatch(mixed.token,'movers','',{price:50,count:2,revision:0});
 assert.equal(done.count,2);assert.equal(done.charged,50);assert.equal(await balance(),20);
 console.log('PASS: free period dispatch, contact, catalog, cabinet; paid mode switch on and off');
})().catch(e=>{console.error(e);process.exit(1);});
