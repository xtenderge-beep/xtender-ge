// Список /admin/masters показывает работу менеджера с исполнителем без захода в карточку:
// кто ведёт, когда менеджер открывал карточку, последнее изменение, заметки и описание.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {newDb}=require('pg-mem');
const db=newDb();db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
const {Pool}=db.adapters.createPg(),pool=new Pool();
pool.withTransaction=async fn=>{const b=db.backup();try{return await fn(pool);}catch(e){b.restore();throw e;}};
require.cache[require.resolve('../src/config/db')]={exports:pool};
require.cache[require.resolve('../src/config/redis')]={exports:new(require('ioredis-mock'))()};
const portal=require('../src/services/managerPortal.service');
const adminService=require('../src/services/admin.service');
(async()=>{
 const a=(await pool.query("INSERT INTO managers(name,phone) VALUES('Alice','111') RETURNING id")).rows[0].id;
 const b=(await pool.query("INSERT INTO managers(name,phone) VALUES('Bob','222') RETURNING id")).rows[0].id;
 const own=(await pool.query("INSERT INTO masters(name,phone,manager_id,is_banned,description) VALUES('Own','333',$1,false,'Грузчики, 5 лет опыта') RETURNING id",[a])).rows[0].id;
 const pending=(await pool.query("INSERT INTO masters(name,phone,is_active,is_banned) VALUES('Pending','444',false,false) RETURNING id")).rows[0].id;
 const alone=(await pool.query("INSERT INTO masters(name,phone,is_banned) VALUES('Alone','555',false) RETURNING id")).rows[0].id;

 // Просмотр карточки пишется и в «своей» карточке, и в карточке модерации; повтор увеличивает счётчик.
 await portal.detail(a,own);await portal.detail(a,own);
 await portal.reviewGet(b,pending);
 let views=(await pool.query('SELECT manager_id,master_id,view_count FROM manager_master_views ORDER BY master_id')).rows;
 assert.deepEqual(views.map(v=>[v.manager_id,v.master_id,v.view_count]),[[a,own,2],[b,pending,1]]);
 // Чужую карточку открыть нельзя — и просмотр тогда не пишется.
 await assert.rejects(()=>portal.detail(b,own),{status:404});
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM manager_master_views WHERE manager_id=$1 AND master_id=$2',[b,own])).rows[0].n,0);

 await portal.action(a,own,'note','Первая заметка');
 await portal.action(a,own,'ban','Спам');
 await portal.action(a,own,'unban','Разобрались');
 for(let i=2;i<=5;i++) await portal.action(a,own,'note','Заметка '+i);

 const list=await adminService.listMastersAdmin();
 const row=list.find(m=>m.id===own);
 assert.equal(row.manager_name,'Alice');
 assert.equal(row.manager_view.view_count,2);
 assert.equal(row.last_view.manager_name,'Alice');
 assert.equal(row.last_change.action,'unban');
 assert.equal(row.last_change.body,'Разобрались');
 assert.deepEqual(row.notes.map(n=>n.body),['Заметка 5','Заметка 4','Заметка 3','Заметка 2','Первая заметка']);
 assert.equal(row.description,'Грузчики, 5 лет опыта');
 const unassigned=list.find(m=>m.id===pending);
 assert.equal(unassigned.manager_name,null);
 assert.equal(unassigned.last_view.manager_name,'Bob');
 const empty=list.find(m=>m.id===alone);
 assert.deepEqual([empty.manager_name,empty.last_view,empty.last_change,empty.notes,empty.description],[null,null,null,[],'']);

 const ejs=require('ejs'),views_=path.join(__dirname,'../src/views'),file=path.join(views_,'admin/masters.ejs');
 const html=ejs.render(fs.readFileSync(file,'utf8'),
  {masters:list.map(m=>({...m,category_label:'Грузчики'})),languageSummary:adminService.languageSummary(list),managerSummary:adminService.managerSummary(list),languageNames:require('../src/config/spokenLanguages').ruNames,filter:{status:'',lang:'',site:'',manager:''},csrfToken:'csrf'},
  {filename:file,includer:(original,parsed)=>original==='./_header'||original==='./_footer'?{template:''}:{filename:parsed}});
 assert.match(html,/href="\/admin\/managers\/\d+" [^>]*>Alice<\/a>/);
 assert.match(html,/открывал карточку: <b[^>]*>[^<]+<\/b> \(2 раз\)/);
 assert.match(html,/последним смотрел Bob/);
 assert.match(html,/разблокировал: <span[^>]*>Разобрались<\/span>/);
 assert.match(html,/Заметки \(5\)/);
 assert.match(html,/<summary[^>]*>Ещё 2<\/summary>/);
 assert.match(html,/Грузчики, 5 лет опыта/);
 assert.match(html,/менеджеры ничего не меняли/);
 assert.match(html,/не назначен/);

 // Фильтр по менеджеру: плашки с числами и выборка по id / без менеджера.
 const summary=adminService.managerSummary(list);
 assert.deepEqual(summary.managers.map(m=>[m.name,m.count]),[['Alice',1]]);
 assert.equal(summary.none,2);
 assert.deepEqual(adminService.filterByManager(list,String(a)).map(m=>m.id),[own]);
 assert.deepEqual(adminService.filterByManager(list,'none').map(m=>m.id).sort(),[pending,alone].sort());
 assert.equal(adminService.filterByManager(list,'').length,list.length);
 assert.ok(html.includes('href="/admin/masters?manager='+a+'" '),'manager chip link');
 assert.match(html,/>Alice <b>1<\/b><\/a>/);
 assert.match(html,/href="\/admin\/masters\?manager=none"[^>]*>Без менеджера <b>2<\/b>/);

 // Удаление исполнителя убирает и его просмотры.
 await require('../src/services/master.service').deleteMaster(own);
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM manager_master_views WHERE master_id=$1',[own])).rows[0].n,0);
 console.log('PASS: admin masters list shows manager, card views, last change, notes and description');
})().catch(e=>{console.error(e);process.exit(1);});
