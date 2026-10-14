// Досылка открытой заявки новым исполнителям: после рассылки появились подходящие, которым заявка не
// уходила (новый в городе, пополнил баланс). Кнопкой, пока заявка открыта, тем же отбором и одним
// списанием; кто подходит, но не получит, виден с балансом и причиной.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const db=require('pg-mem').newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const backup=db.backup();try{return await fn(pool);}catch(e){backup.restore();throw e;}};
const stub=(p,exports)=>require.cache[require.resolve(p)]={exports};
stub('../src/config/db',pool);const redis=new(require('ioredis-mock'))();stub('../src/config/redis',redis);
const sms=[];
stub('../src/services/sms.service',{sendOrderNotification:async(phone,text,context)=>{if(context?.kind==='lead')sms.push(phone);return {ok:true,providerMessageId:'test'};}});
stub('../src/services/translation.service',{translateOrder:async()=>null,detectLang:()=> 'ru'});
stub('../src/services/telegram.service',{updateMessage:async()=>{},sendToChat:async()=>{},sendLeadToMaster:async()=>false});
const masters=require('../src/services/master.service'),dispatch=require('../src/services/dispatch.service'),orders=require('../src/services/order.service');
let seq=0;
const phoneOf=async id=>(await pool.query('SELECT phone FROM masters WHERE id=$1',[id])).rows[0].phone;
const fund=async id=>{await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[id]);await require('./billing-fixture')(pool,id);};
async function provider(name,{funded=true,languages=['ru'],services=[{type:'movers',attributes:{crew_size:2}}]}={}) {
  const m=await masters.registerMaster({name,phone:'+99550000800'+(++seq),serviceType:null});
  await masters.updateMasterProfile(m.id,{name,phone:m.phone,services,cityIds:[1],spokenLanguages:languages});
  await masters.approveMaster(m.id);
  await pool.query('UPDATE masters SET balance_tetri=0 WHERE id=$1',[m.id]);
  if(funded) await fund(m.id);
  return m.id;
}
const charges=async(id,orderId)=>(await pool.query("SELECT COUNT(*)::int AS n FROM balance_transactions WHERE master_id=$1 AND order_id=$2 AND reason='lead_charge'",[id,orderId])).rows[0].n;
const names=list=>list.map(m=>m.name);
(async()=>{
  const first=await provider('Первый');
  const poor=await provider('Без денег',{funded:false});
  const order=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('late-1','+995500008999','Погрузка мебели','pending_review') RETURNING *")).rows[0];
  const before=await dispatch.newcomers(order.token);
  assert.deepEqual([before.total,before.groups],[0,[]],'до рассылки досылать нечего');
  await dispatch.sendNeeds(order.token,{needs:['movers']},null,'',{actor:'manager:test'});
  assert.deepEqual(sms,[await phoneOf(first)]);
  assert.equal((await dispatch.newcomers(order.token)).total,0,'сразу после рассылки новых нет');

  // Подходит, но не получил: без баланса; со своими деньгами без подтверждённых тарифов.
  const unconfirmed=await provider('Без тарифов',{funded:false});
  await pool.query('UPDATE masters SET balance_tetri=5000 WHERE id=$1',[unconfirmed]);
  await pool.query("INSERT INTO balance_transactions(master_id,amount_tetri,reason) VALUES($1,5000,'topup')",[unconfirmed]);
  let screen=await dispatch.screen(order.token);
  assert.deepEqual(screen.missed.map(m=>[m.name,m.reason,m.balance_tetri,m.service]),[['Без денег','balance',0,'💪 Грузчики'],['Без тарифов','billing',5000,'💪 Грузчики']]);

  // Появились новые подходящие: новый в городе и пополнивший баланс. Говорящий только по-грузински тоже
  // подходит: рассылка была «всем».
  const newcomer=await provider('Новый');
  await fund(poor);
  const georgian=await provider('Грузинский',{languages:['ka']});
  await provider('Не та услуга',{services:[{type:'van',attributes:{body:'closed',cargo_length_cm:300,cargo_width_cm:175,cargo_height_cm:180}}]});
  // Заявка уже уходила с ошибкой доставки — это не «новый», для него повтор ошибок.
  const lost=await provider('Не дошло');
  const run=(await pool.query('SELECT id FROM dispatch_runs WHERE order_id=$1 ORDER BY id LIMIT 1',[order.id])).rows[0].id;
  await pool.query("INSERT INTO dispatch_deliveries(run_id,order_id,master_id,status,reason) VALUES($1,$2,$3,'failed','channel_rejected')",[run,order.id,lost]);
  let plan=await dispatch.newcomers(order.token);
  assert.deepEqual(names(plan.recipients),['Без денег','Новый','Грузинский']);
  assert.deepEqual(plan.groups.map(g=>[g.key,g.size,g.language,g.ids.length]),[['movers','','',3]]);
  screen=await dispatch.screen(order.token);
  assert.equal(screen.newcomers.total,3);assert.deepEqual(names(screen.missed),['Без тарифов']);
  assert.deepEqual(await dispatch.newcomerCounts(),{[order.token]:3},'в списке заявок видно, что можно дослать');
  const page=await require('ejs').renderFile(path.join(__dirname,'../src/views/partials/order-screen.ejs'),{...screen,base:'/manager/orders/'+order.token,listHref:'/manager/orders',csrf:'x',canCloseNeed:false,masterHref:'',result:null,error:null,date:()=>''});
  assert.match(page,/<b>Новые подходящие: 3<\/b>/);
  assert.match(page,/<input type="hidden" name="expectedTotal" value="3"><input type="hidden" name="expectedPrice" value="\d+">/);
  assert.match(page,new RegExp('<button>Дослать 3 исполнителям и списать '+(3*plan.price/100).toFixed(2)+' ₾</button>'));
  assert.match(page,/Без тарифов · 💪 Грузчики · тарифы не подтверждены, баланс 50\.00 ₾/);
  // Ссылки на карточки: в админке — на любого исполнителя, у менеджера — только на своих.
  const managerId=(await pool.query("INSERT INTO managers(name,phone) VALUES('Менеджер','+995500008100') RETURNING id")).rows[0].id;
  await pool.query('UPDATE masters SET manager_id=$1 WHERE id=$2',[managerId,newcomer]);
  const screenWith=async locals=>require('ejs').renderFile(path.join(__dirname,'../src/views/partials/order-screen.ejs'),{...await dispatch.screen(order.token),base:'/x',listHref:'/x',csrf:'x',canCloseNeed:false,result:null,error:null,date:()=>'',...locals});
  const managerPage=await screenWith({masterHref:'/manager/masters/',ownManagerId:managerId});
  assert.match(managerPage,new RegExp('<a href="/manager/masters/'+newcomer+'">Новый</a>'));
  assert.ok(!managerPage.includes('/manager/masters/'+unconfirmed+'"')&&!managerPage.includes('/manager/masters/'+first+'"'),'чужие карточки менеджеру не открываются');
  const adminPage=await screenWith({masterHref:'/admin/masters/'});
  for(const id of [newcomer,unconfirmed,first]) assert.ok(adminPage.includes('<a href="/admin/masters/'+id+'">'),'в админке ссылка на каждого');
  // В карточке — кнопки связи: WhatsApp на номер из «Мессенджеров», иначе на основной.
  await pool.query('UPDATE masters SET contact_channels=$1::jsonb WHERE id=$2',[JSON.stringify({whatsapp:'+995555123456'}),newcomer]);
  assert.equal((await require('../src/services/admin.service').getMasterDetail(newcomer)).whatsapp_url,'https://wa.me/995555123456');
  assert.equal((await require('../src/services/admin.service').getMasterDetail(first)).whatsapp_url,'https://wa.me/'+(await phoneOf(first)).slice(1));
  assert.equal((await require('../src/services/managerPortal.service').detail(managerId,newcomer)).master.whatsapp_url,'https://wa.me/995555123456');
  const list=await require('ejs').renderFile(path.join(__dirname,'../src/views/manager/orders.ejs'),{orders:await dispatch.orderList(),manager:{name:'Тест'},csrf:'x',date:()=>''});
  assert.match(list,new RegExp('<span class="new" data-newcomers="'+order.token+'" hidden></span>'));assert.match(list,/fetch\('\/manager\/orders-newcomers'\)/);

  // Числа изменились после того, как менеджер их увидел, — ничего не отправляется.
  await assert.rejects(()=>dispatch.sendNewcomers(order.token,{total:2,price:plan.price},'manager:test'),/изменились/);
  assert.equal(sms.length,1);
  const sent=await dispatch.sendNewcomers(order.token,{total:3,price:plan.price},'manager:test');
  assert.deepEqual([sent.count,sent.price,sent.results.map(r=>[r.key,r.count])],[3,plan.price,[['movers',3]]]);
  assert.deepEqual(sms.slice(1).sort(),(await Promise.all([poor,newcomer,georgian].map(phoneOf))).sort());
  for(const id of [first,poor,newcomer,georgian]) assert.equal(await charges(id,order.id),1,'каждый платит за заявку один раз');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM order_dispatches WHERE order_id=$1',[order.id])).rows[0].n,1,'досылка — новая отправка той же группы, а не новая группа');
  assert.equal((await orders.getOrderDispatches(order.id)).length,2);
  await assert.rejects(()=>dispatch.sendNewcomers(order.token,{total:0,price:plan.price},'manager:test'),/Новых подходящих исполнителей нет/);
  const report=(await dispatch.screen(order.token)).report;
  assert.equal(report.summary.received,4);
  assert.deepEqual([report.rows.find(r=>r.master_id===first).balance_tetri,report.rows.find(r=>r.master_id===first).low],[5000-plan.price,false]);

  // Баланс меньше цены заявки: в отчёте помечен — следующую заявку не получит.
  await pool.query('UPDATE masters SET balance_tetri=10 WHERE id=$1',[first]);
  assert.equal((await require('../src/services/recipientReport.service').build(order.id)).rows.find(r=>r.master_id===first).low,true);

  // Рассылка только говорящим по-русски: новый грузиноязычный исполнитель досылку не получит.
  const ruOrder=(await pool.query("INSERT INTO orders(token,phone,description,status) VALUES('late-2','+995500008998','Разгрузка','pending_review') RETURNING *")).rows[0];
  await dispatch.sendNeeds(ruOrder.token,{needs:['movers']},null,'ru',{actor:'manager:test'});
  await provider('Ещё грузинский',{languages:['ka']});
  const russian=await provider('Ещё русский');
  assert.deepEqual(names((await dispatch.newcomers(ruOrder.token)).recipients),['Ещё русский']);
  // Закрытая услуга и закрытая заявка — досылки нет.
  await pool.query("INSERT INTO order_category_closures(order_id,category,closed_by,reason) VALUES($1,'movers','client','done')",[ruOrder.id]);
  assert.equal((await dispatch.newcomers(ruOrder.token)).total,0);
  await orders.closeOrder(order.token,{actor:'admin'});
  assert.equal((await dispatch.newcomers(order.token)).total,0);
  await assert.rejects(()=>dispatch.sendNewcomers(order.token,{total:1,price:plan.price},'admin'),/Новых подходящих исполнителей нет/);
  assert.equal(await charges(russian,ruOrder.id),0);
  console.log('PASS: dispatch newcomers — open order sent again to providers who appeared later, same group rules, one charge each; missed providers with balance and reason');
  redis.disconnect();
})().catch(e=>{console.error(e);process.exitCode=1;redis.disconnect();});
