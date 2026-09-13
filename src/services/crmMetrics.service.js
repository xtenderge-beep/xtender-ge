const pool=require('../config/db');
const {monthBounds}=require('./partner.service');
const unique=(rows,key)=>new Set(rows.map(r=>r[key])).size;
const within=(value,start,end)=>value&&new Date(value)>=start&&new Date(value)<end;
async function report(managerId,month){
 const range=monthBounds(month),now=new Date(),today=new Date(new Date(+now+14400000).toISOString().slice(0,10)+'T00:00:00+04:00');
 const [managers,invites,masters,topups,orders,deliveries,views,plans,runs,clientViews]=await Promise.all([
  pool.query('SELECT id,name FROM managers WHERE ($1::int IS NULL OR id=$1) ORDER BY name',[managerId]),
  pool.query('SELECT * FROM crm_invites WHERE ($1::int IS NULL OR manager_id=$1)',[managerId]),
  pool.query('SELECT id,referral_manager_id,created_at,is_active FROM masters WHERE ($1::int IS NULL OR referral_manager_id=$1)',[managerId]),
  pool.query("SELECT b.master_id,b.amount_tetri,b.created_at,m.referral_manager_id,m.referral_bound_at FROM balance_transactions b JOIN masters m ON m.id=b.master_id WHERE b.reason='topup' AND b.amount_tetri>0 AND ($1::int IS NULL OR m.referral_manager_id=$1) ORDER BY b.created_at,b.id",[managerId]),
  pool.query('SELECT id,manager_id,created_at,confirmed_at,status,first_dispatched_at,closed_at,closed_by,closing_reason FROM orders WHERE ($1::int IS NULL OR manager_id=$1)',[managerId]),
  pool.query('SELECT * FROM dispatch_deliveries WHERE ($1::int IS NULL OR manager_id=$1)',[managerId]),
  pool.query("SELECT v.order_id,v.master_id,v.viewed_at FROM order_views v JOIN dispatch_deliveries d ON d.order_id=v.order_id AND d.master_id=v.master_id WHERE v.event_type IN ('call','whatsapp') AND ($1::int IS NULL OR d.manager_id=$1)",[managerId]),
  pool.query('SELECT * FROM manager_plans WHERE month=$1 AND ($2::int IS NULL OR manager_id=$2)',[range.month,managerId]),
  managerId?pool.query('SELECT run_id AS id,created_at FROM dispatch_deliveries WHERE manager_id=$1',[managerId]):pool.query('SELECT id,created_at FROM dispatch_runs'),
  pool.query("SELECT v.order_id,v.viewed_at,o.manager_id FROM order_views v JOIN orders o ON o.id=v.order_id WHERE v.event_type IN ('call','whatsapp') AND ($1::int IS NULL OR o.manager_id=$1)",[managerId])
 ]);
 const first=new Map();for(const t of topups.rows)if(!first.has(t.master_id))first.set(t.master_id,t);
 function calculate(id,start,end){
  const own=(rows,key)=>rows.filter(r=>id===null||r[key]===id);
  const source=own(masters.rows,'referral_manager_id'),registered=source.filter(m=>within(m.created_at,start,end));
  const payments=own(topups.rows,'referral_manager_id').filter(t=>within(t.created_at,start,end)&&(id===null||!t.referral_bound_at||new Date(t.created_at)>=new Date(t.referral_bound_at)));
  const firstPaid=own([...first.values()],'referral_manager_id').filter(t=>within(t.created_at,start,end)&&(id===null||!t.referral_bound_at||new Date(t.created_at)>=new Date(t.referral_bound_at)));
  const paidIds=new Set(payments.map(p=>p.master_id)),firstIds=new Set(firstPaid.map(p=>p.master_id));
  const leads=own(invites.rows,'manager_id');
  const sent=kind=>unique(leads.filter(i=>(kind==='provider'?i.kind==='provider':i.kind!=='provider')&&within(i.sent_at,start,end)),'phone');
  const opened=kind=>unique(leads.filter(i=>(kind==='provider'?i.kind==='provider':i.kind!=='provider')&&within(i.opened_at,start,end)),'phone');
  const ownOrders=own(orders.rows,'manager_id'); const confirmed=ownOrders.filter(o=>within(o.confirmed_at,start,end)); const firstContact=new Map(); for(const v of own(clientViews.rows,'manager_id')){if(!firstContact.has(v.order_id)||new Date(v.viewed_at)<new Date(firstContact.get(v.order_id)))firstContact.set(v.order_id,v.viewed_at);}
  const delivery=own(deliveries.rows,'manager_id').filter(d=>within(d.created_at,start,end));
  const accepted=delivery.filter(d=>d.status==='accepted');
  const pairs=new Map();for(const d of accepted){const key=d.order_id+':'+d.master_id;if(!pairs.has(key)||new Date(d.created_at)<new Date(pairs.get(key)))pairs.set(key,d.created_at);}
  const contacts=new Map();for(const v of views.rows){const key=v.order_id+':'+v.master_id;const startAt=pairs.get(key);if(startAt&&new Date(v.viewed_at)>=new Date(startAt)&&new Date(v.viewed_at)<end&&(!contacts.has(key)||new Date(v.viewed_at)<new Date(contacts.get(key))))contacts.set(key,v.viewed_at);}
  const minutes=[...contacts].map(([key,time])=>(new Date(time)-new Date(pairs.get(key)))/60000);
  return {client_confirmed:confirmed.length,client_contacted:[...firstContact.values()].filter(t=>within(t,start,end)).length,providerCreated:unique(leads.filter(i=>i.kind==='provider'&&within(i.created_at,start,end)),'phone'),clientCreated:unique(leads.filter(i=>i.kind!=='provider'&&within(i.created_at,start,end)),'phone'),approvedCohort:registered.filter(m=>m.is_active).length,clientDispatched:ownOrders.filter(o=>within(o.first_dispatched_at,start,end)).length,clientContacted:[...firstContact.values()].filter(t=>within(t,start,end)).length,clientClosed:ownOrders.filter(o=>o.closed_by==='client'&&within(o.closed_at,start,end)).length,registrations:registered.length,first_payers:firstPaid.length,payers:paidIds.size,repeat_payers:[...paidIds].filter(x=>new Date(first.get(x).created_at)<start).length,payment_operations:payments.length,revenue_tetri:payments.reduce((n,p)=>n+Number(p.amount_tetri),0),providerSent:sent('provider'),providerOpened:opened('provider'),clientSent:sent('client'),clientOpened:opened('client'),confirmed:confirmed.length,waiting:leads.filter(i=>i.kind!=='provider'&&own(orders.rows,'manager_id').some(o=>o.id===i.order_id&&o.status==='unverified')).length,cohortPaid:registered.filter(m=>first.has(m.id)&&new Date(first.get(m.id).created_at)<end).length,dispatches:id===null?unique(runs.rows.filter(r=>within(r.created_at,start,end)),'id'):unique(delivery,'run_id'),selected:delivery.length,accepted:accepted.length,failed:delivery.filter(d=>d.status==='failed').length,pending:delivery.filter(d=>d.status==='pending').length,skipped:delivery.filter(d=>d.status==='skipped').length,responded:contacts.size,averageMinutes:minutes.length?minutes.reduce((n,m)=>n+m,0)/minutes.length:null};
 }
 const totals=calculate(managerId,range.start,range.end),day=calculate(managerId,today,new Date(+today+86400000));
 const rows=managers.rows.map(m=>({...m,actual:calculate(m.id,range.start,range.end),plan:plans.rows.find(p=>p.manager_id===m.id)||{registrations:0,first_payers:0,payers:0,revenue_tetri:0,client_confirmed:0,client_contacted:0}}));
 const daysLeft=now<range.start?Math.round((range.end-range.start)/86400000):now>=range.end?0:Math.ceil((range.end-now)/86400000);
 return {month:range.month,totals,day,rows,daysLeft};
}
module.exports={report};
