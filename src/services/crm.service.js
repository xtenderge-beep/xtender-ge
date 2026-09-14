const crypto=require('crypto');
const pool=require('../config/db');
const {normalizeGeorgianPhone}=require('../config/phone');
const {generateShortId}=require('../config/shortId');
const partners=require('./partner.service');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function validId(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw fail('Некорректный ID.');return n;}
function details(body){const description=String(body.description||'').trim(),districtName=String(body.districtName||'').trim();if(description.length<5||description.length>5000||districtName.length>500)throw fail('Описание: 5–5000 символов; адрес: до 500 символов.');return {description,districtName};}
async function invite(managerId,input,actor='manager'){
 managerId=validId(managerId);const phone=normalizeGeorgianPhone(input.phone);
 if(!phone)throw fail('Укажите грузинский номер: +995 и 9 цифр.');
 if(!['provider','client','operator'].includes(input.kind))throw fail('Выберите тип приглашения.');
 if(!/^[a-f0-9-]{36}$/.test(input.requestKey||''))throw fail('Обновите форму.');
 const draft=input.kind==='operator'?details(input):{description:'',districtName:''};
 const manager=await partners.getManager(managerId);if(!manager?.is_active)throw fail('Менеджер выключен или не найден.');
 if(input.kind==='provider')await partners.createLink(managerId);
 return pool.withTransaction(async tx=>{
  const previous=(await tx.query('SELECT * FROM crm_invites WHERE request_key=$1',[input.requestKey])).rows[0];
  if(previous){if(previous.manager_id!==managerId||previous.phone!==phone||previous.kind!==input.kind)throw fail('Ключ формы уже использован.',409);return previous;}
  // Reserve the idempotency key before creating an order, including concurrent retries.
  const token=crypto.randomBytes(16).toString('hex');
  const inserted=(await tx.query('INSERT INTO crm_invites(manager_id,kind,phone,token,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_key) DO NOTHING RETURNING *',[managerId,input.kind,phone,token,input.requestKey,actor])).rows[0];
  if(!inserted){const prior=(await tx.query('SELECT * FROM crm_invites WHERE request_key=$1',[input.requestKey])).rows[0];if(prior.manager_id!==managerId||prior.phone!==phone||prior.kind!==input.kind)throw fail('Ключ формы уже использован.',409);return prior;}
  if(input.kind!=='provider'){
   const order=(await tx.query("INSERT INTO orders(phone,description,district_name,token,owner_token,status,manager_id,origin) VALUES($1,$2,$3,$4,$5,'unverified',$6,$7) RETURNING id",[phone,draft.description,draft.districtName,generateShortId(),generateShortId(),managerId,input.kind==='operator'?'operator':'manager_invite'])).rows[0];
   await tx.query('UPDATE crm_invites SET order_id=$2 WHERE id=$1',[inserted.id,order.id]);inserted.order_id=order.id;
  }
  return inserted;
 });
}
async function getInvite(id,managerId){const row=(await pool.query('SELECT i.*,o.description,o.district_name,o.status,o.confirmed_at FROM crm_invites i LEFT JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND ($2::int IS NULL OR i.manager_id=$2)',[validId(id),managerId])).rows[0];if(!row)throw fail('Приглашение не найдено.',404);return row;}
async function markSent(id,managerId){await getInvite(id,managerId);await pool.query('UPDATE crm_invites SET sent_at=COALESCE(sent_at,NOW()) WHERE id=$1 AND ($2::int IS NULL OR manager_id=$2)',[id,managerId]);}
async function note(id,managerId,body){const row=await getInvite(id,managerId);body=String(body||'').trim();if(!body||body.length>2000)throw fail('Заметка: 1–2000 символов.');await pool.query('INSERT INTO crm_notes(invite_id,manager_id,body,actor) VALUES($1,$2,$3,$4)',[row.id,managerId||row.manager_id,body,managerId?'manager':'admin']);}
async function publicInvite(token){if(!/^[a-f0-9]{32}$/.test(token||''))throw fail('Ссылка не найдена.',404);const row=(await pool.query('SELECT i.*,m.referral_token,m.is_active,o.description,o.district_name,o.status,o.token AS order_token FROM crm_invites i JOIN managers m ON m.id=i.manager_id LEFT JOIN orders o ON o.id=i.order_id WHERE i.token=$1',[token])).rows[0];if(!row)throw fail('Ссылка не найдена.',404);return row;}
async function open(token){const row=await publicInvite(token);if(!row.is_active&&row.kind==='provider')throw fail('Приглашение больше не активно.',404);await pool.query('UPDATE crm_invites SET opened_at=COALESCE(opened_at,NOW()) WHERE id=$1',[row.id]);return row;}
async function list(managerId,q='',page=1){page=Math.max(1,Math.min(10000,parseInt(page)||1));q=String(q).slice(0,100);return (await pool.query('SELECT i.*,m.name AS manager_name,o.description,o.status,o.confirmed_at FROM crm_invites i JOIN managers m ON m.id=i.manager_id LEFT JOIN orders o ON o.id=i.order_id WHERE ($1::int IS NULL OR i.manager_id=$1) AND i.phone ILIKE $2 ORDER BY i.created_at DESC,i.id DESC LIMIT 51 OFFSET $3',[managerId,'%'+q+'%',(page-1)*50])).rows;}
async function card(id,managerId){const item=await getInvite(id,managerId);const notes=(await pool.query('SELECT n.body,n.created_at,n.actor,m.name FROM crm_notes n JOIN managers m ON m.id=n.manager_id WHERE n.invite_id=$1 ORDER BY n.id DESC LIMIT 100',[item.id])).rows;let files=[],activity=[];if(item.order_id){files=(await pool.query('SELECT file_path,original_name FROM order_files WHERE order_id=$1',[item.order_id])).rows;activity=(await pool.query('SELECT event_type,viewed_at FROM order_views WHERE order_id=$1 ORDER BY viewed_at DESC LIMIT 100',[item.order_id])).rows;}const related=(await pool.query('SELECT id,kind,created_at,order_id FROM crm_invites WHERE phone=$1 AND ($2::int IS NULL OR manager_id=$2) ORDER BY created_at DESC LIMIT 100',[item.phone,managerId])).rows;return {item,notes,files,activity,related};}
async function savePlan(managerId,month,input){managerId=validId(managerId);partners.monthBounds(month);if(!await partners.getManager(managerId))throw fail('Менеджер не найден.',404);const values=['registrations','first_payers','payers','client_confirmed','client_contacted'].map(k=>{const n=Number(input[k]??0);if(!Number.isSafeInteger(n)||n<0||n>1000000)throw fail('План: целое число от 0 до 1 000 000.');return n;});values.push(partners.decimalToInt(input.revenue,100000000));await pool.withTransaction(async tx=>{await tx.query('INSERT INTO manager_plans(manager_id,month,registrations,first_payers,payers,client_confirmed,client_contacted,revenue_tetri) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(manager_id,month) DO UPDATE SET registrations=EXCLUDED.registrations,first_payers=EXCLUDED.first_payers,payers=EXCLUDED.payers,revenue_tetri=EXCLUDED.revenue_tetri,client_confirmed=EXCLUDED.client_confirmed,client_contacted=EXCLUDED.client_contacted,updated_at=NOW()',[managerId,month,...values]);await tx.query("INSERT INTO manager_portal_events(manager_id,action,body) VALUES($1,'plan_changed',$2)",[managerId,JSON.stringify({month,registrations:values[0],first_payers:values[1],payers:values[2],client_confirmed:values[3],client_contacted:values[4],revenue_tetri:values[5]})]);});}
module.exports={fail,validId,details,invite,getInvite,markSent,note,publicInvite,open,list,card,savePlan};
