const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {newDb,DataType}=require('pg-mem'),db=newDb();
db.public.registerFunction({name:'replace',args:[DataType.text,DataType.text,DataType.text],returns:DataType.text,implementation:(s,a,b)=>s.split(a).join(b)});
db.public.none(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
db.public.none("INSERT INTO masters(name,phone,category) VALUES('Migration test','+995500000797','movers'); INSERT INTO balance_transactions(master_id,amount_tetri,reason,note) VALUES(1,-50,'catalog_call','Звонок из каталога: +995500000798'),(1,-50,'catalog_call','Звонок из каталога: +995500000798'),(1,-50,'lead_charge','other');");
const sql=fs.readFileSync(path.join(__dirname,'../schema.postgres.sql'),'utf8').split('-- Preserve paid unlocks from before this migration.')[1];
db.public.none(sql);db.public.none(sql);
const rows=db.public.many('SELECT * FROM catalog_contact_access');assert.equal(rows.length,1);assert.equal(rows[0].caller_phone,'+995500000798');
console.log('PASS: existing catalog payments become one durable access; repeated migration is idempotent');
