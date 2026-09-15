const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup=db.backup(); try { return await fn(pool); } catch(e) { backup.restore(); throw e; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
const topups = require('../src/services/topup.service');
const receipts = require('../src/services/receipt.service');

(async()=>{
  assert.ok(topups.validIban('GE95BG0000000613339218'));
  assert.ok(!topups.validIban('GE94BG0000000613339218'));
  for (const value of ['-5','4.99','1000.01','5.001','1e2','','NaN']) assert.equal(topups.parseAmount(value),null);
  assert.equal(topups.parseAmount('12,50'),1250);
  await pool.query("INSERT INTO masters(name,phone,balance_tetri) VALUES('Тестовый исполнитель','+995500000001',0),('Other','+995500000002',0)");
  const key=crypto.randomUUID();
  const first=await topups.create(1,1250,key);
  assert.equal(first.amount_tetri,1250);
  assert.equal((await topups.create(1,1250,key)).id,first.id);
  await assert.rejects(()=>topups.create(1,1500,key));
  assert.equal(await topups.get(first.id,2),null);
  assert.equal((await pool.query('SELECT balance_tetri FROM masters WHERE id=1')).rows[0].balance_tetri,0);
  const details=await topups.getDetails();
  await topups.saveDetails({...details,RECIPIENT_NAME:'New recipient'});
  assert.equal((await topups.get(first.id,1)).recipient.RECIPIENT_NAME,details.RECIPIENT_NAME);
  assert.equal((await topups.create(1,500,crypto.randomUUID())).recipient.RECIPIENT_NAME,'New recipient');
  await assert.rejects(()=>topups.saveDetails({...details,BANK_ACCOUNT:'GE00BAD'}));
  await assert.rejects(()=>receipts.create(2,'other.pdf',first.id));
  const receipt=await receipts.create(1,'receipt.pdf',first.id);
  assert.equal((await topups.get(first.id,1)).status,'received');
  await assert.rejects(()=>receipts.create(1,'duplicate.pdf',first.id));
  await receipts.review(receipt.id,'rejected','Please send readable receipt');
  const replacement=await receipts.create(1,'clear.pdf',first.id);
  await assert.rejects(()=>receipts.review(receipt.id,'reviewing',''));
  await receipts.review(replacement.id,'reviewing','Checking');
  // Confirming a top-up is the only place that actually moves money now.
  await assert.rejects(()=>receipts.confirmPayment(999,1250,''));
  await assert.rejects(()=>receipts.confirmPayment(first.id,0,''));
  await assert.rejects(()=>receipts.confirmPayment(first.id,1200,'')); // mismatch needs a note
  await receipts.confirmPayment(first.id,1200,'Received 12.00 GEL instead of 12.50');
  const paid=await topups.get(first.id,1);
  assert.equal(paid.status,'credited');assert.equal(paid.credited_tetri,1200);
  assert.equal((await pool.query('SELECT balance_tetri FROM masters WHERE id=1')).rows[0].balance_tetri,1200);
  await assert.rejects(()=>receipts.create(1,'paid.pdf',first.id));
  await assert.rejects(()=>receipts.confirmPayment(first.id,1200,''));
  const another=await topups.create(1,1200,crypto.randomUUID());const anotherReceipt=await receipts.create(1,'second.pdf',another.id);
  assert.equal((await topups.get(another.id,1)).status,'received');
  await receipts.confirmPayment(another.id,1200,'');
  assert.equal((await topups.get(another.id,1)).status,'credited');
  assert.equal((await pool.query('SELECT balance_tetri FROM masters WHERE id=1')).rows[0].balance_tetri,2400);
  // The invoice list surfaces every top-up, including ones without an uploaded receipt,
  // and attaches the latest receipt so admin can confirm payment straight from it.
  const noReceipt=await topups.create(1,1000,crypto.randomUUID());
  const invoices=await receipts.list();
  assert.equal(invoices.find(i=>i.id===noReceipt.id).receipt,null);
  assert.equal(invoices.find(i=>i.id===another.id).receipt.id,anotherReceipt.id);
  assert.equal(invoices.find(i=>i.id===first.id).receipt.id,replacement.id);
  if (process.env.RENDER_PAYMENT_FIXTURES === '1') {
    const output=path.join(__dirname,'../output/pdf');fs.mkdirSync(output,{recursive:true});
    for(const lang of ['ka','ru','en'])fs.writeFileSync(path.join(output,`payment-${lang}.pdf`),await require('../src/services/topup-pdf.service').generate({...first,status:'awaiting'},lang));
  }
  console.log('PASS: amount and IBAN checks; idempotency; ownership; immutable details; upload/review transitions; replacement receipt; confirmPayment credits balance, rejects mismatch without note, double-confirm and unknown top-up; invoice list surfaces receipt-less top-ups.');
})().catch(error=>{console.error(error);process.exitCode=1;});
