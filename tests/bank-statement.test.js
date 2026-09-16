const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
const { parseCredits, matchCredits, getProcessedDocNumbers, recordProcessed } = require('../src/services/bankStatement.service');

const HEADERS = ['Date','Doc N','Account N','Currency','Account Name','Loro Account','Debit','Credit','Rate',
  'Debit In Lari','Credit In Lari','Entry Comment','Operation Type','Operation ID','Ref','Sender Name',
  'Sender Number Taxpayer','Sender Account N','Sender Bank Code','Sender Bank Name','Recipient Name',
  'Recipient Number Taxpayer','Recipient Account N','Recipient Bank Code','Recipient Bank Name',
  'Nomination','Additional Info','Amount','Amount In Lari'];

async function buildStatement(rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Statement of Account');
  sheet.addRow(['', 'JSC Bank of Georgia']);
  sheet.addRow(['', 'Account Owner:', 'IE ARTUR BEJANIAN']);
  sheet.addRow(['', 'Period:', '09.09.2026-16.09.2026']);
  sheet.addRow([]);
  sheet.addRow(HEADERS);
  for (const row of rows) sheet.addRow(row);
  return wb.xlsx.writeBuffer();
}
function row({ date = '16.09.2026', doc = '', credit = null, nomination = '', additionalInfo = nomination }) {
  const base = new Array(HEADERS.length).fill(null);
  base[0] = date; base[1] = doc; base[7] = credit; base[10] = credit; base[25] = nomination; base[11] = nomination; base[26] = additionalInfo;
  return base;
}

(async () => {
  await pool.query("INSERT INTO masters(name,phone,balance_tetri) VALUES('Тестовый исполнитель','+995500000001',0)");
  await pool.query(`INSERT INTO topup_requests (master_id, amount_tetri, reference, request_key, recipient, payer_name)
    VALUES (1, 1000, 'XT-622D25271A12', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}'::jsonb, 'Тестовый мастер')`); // id=1, referenced by recordProcessed below

  const buffer = await buildStatement([
    row({ date: '11.09.2026', doc: 'DOC-1', credit: 30, nomination: 'tankhis gadaritskhva' }), // no reference — a real transfer with a generic purpose
    row({ date: '16.09.2026', doc: 'DOC-2', credit: 5, nomination: 'balansis shevseba, opherta № XT-622D25271A12, 2026-09-15, tankha 10.00 GEL' }), // partial payment
    row({ date: '16.09.2026', doc: 'DOC-3', credit: 12.5, nomination: 'balansis shevseba, opherta XT-aaaaaaaaaaaa' }), // lowercase reference still matches
    row({ date: '16.09.2026', doc: 'DOC-4', credit: null, nomination: 'XT-000000000000' }), // debit/no credit — must be ignored
    // Real statement: same row had a DIFFERENT reference in "Nomination" than in
    // "Additional Info" (a stale one left over next to the current one) — both must
    // be picked up, not just whichever column happens to be checked first.
    row({ date: '15.09.2026', doc: 'DOC-5', credit: 50, nomination: 'balansis shevseba, opherta № XT-B1B1B1B1B1B1, 2026-09-14, tankha 50.00 GEL', additionalInfo: 'balansis shevseba, opherta № XT-E249D9E0F0E7, 2026-09-15, tankha 50.00 GEL' }),
  ]);

  const garbageBuffer = await buildGarbage();
  const credits = await parseCredits(buffer);
  assert.equal(credits.length, 5); // the no-reference row is now kept, not dropped
  const generic = credits.find(c => c.reference === null);
  assert.equal(generic.amountTetri, 3000);
  assert.equal(generic.docNumber, 'DOC-1');
  const referenced = credits.filter(c => c.reference);
  assert.equal(referenced.length, 4);
  assert.equal(referenced.find(c => c.amountTetri === 500).reference, 'XT-622D25271A12');
  assert.equal(referenced.find(c => c.amountTetri === 1250).reference, 'XT-AAAAAAAAAAAA'); // normalized to uppercase
  const lastRowRefs = referenced.filter(c => c.amountTetri === 5000).map(c => c.reference).sort();
  assert.deepEqual(lastRowRefs, ['XT-B1B1B1B1B1B1', 'XT-E249D9E0F0E7']);
  assert.ok(referenced.filter(c => c.amountTetri === 5000).every(c => c.docNumber === 'DOC-5'));

  await assert.rejects(() => parseCredits(garbageBuffer), /Date/);

  // A real Excel date cell comes back as a JS Date, not a string — must format as
  // DD.MM.YYYY like the bank's own text cells, not toString() junk.
  const dateBuffer = await buildStatement([row({ date: new Date(Date.UTC(2026, 8, 16)), doc: 'DOC-DATE', credit: 7, nomination: 'XT-DA7EDA7EDA7E' })]);
  const dateCredits = await parseCredits(dateBuffer);
  assert.equal(dateCredits[0].date, '16.09.2026');

  const topups = [
    { id: 1, reference: 'XT-622D25271A12', amount_tetri: 1000, status: 'awaiting' },
    { id: 2, reference: 'XT-AAAAAAAAAAAA', amount_tetri: 1250, status: 'received' },
    { id: 3, reference: 'XT-622D25271A12', amount_tetri: 1000, status: 'credited' }, // same reference, already paid — must not re-match
    { id: 4, reference: 'XT-NOMATCH00000', amount_tetri: 500, status: 'awaiting' }, // never mentioned in the statement at all
    { id: 5, reference: 'XT-E249D9E0F0E7', amount_tetri: 5000, status: 'awaiting' }, // the reference that was hiding in "Additional Info"
  ];
  const result = matchCredits(topups, credits);
  assert.equal(result.totalCredits, 5);
  assert.equal(result.skipped, 0);
  assert.equal(result.matched, 3);
  assert.equal(result.topups.find(t => t.id === 1).statementMatch.amountTetri, 500);
  assert.equal(result.topups.find(t => t.id === 2).statementMatch.amountTetri, 1250);
  assert.equal(result.topups.find(t => t.id === 3).statementMatch, undefined);
  assert.equal(result.topups.find(t => t.id === 4).statementMatch, undefined);
  assert.equal(result.topups.find(t => t.id === 5).statementMatch.amountTetri, 5000);
  // Unmatched: the generic no-reference payment, plus XT-B1B1B1B1B1B1 which doesn't
  // correspond to any invoice at all — both need a human to assign them by hand.
  assert.equal(result.unmatched.length, 2);
  assert.ok(result.unmatched.some(c => c.reference === null && c.amountTetri === 3000));
  assert.ok(result.unmatched.some(c => c.reference === 'XT-B1B1B1B1B1B1' && c.amountTetri === 5000));

  // Re-uploading the same (or an overlapping) statement must not offer the already
  // -handled rows again — DOC-2 was credited to topup 1, DOC-1 was explicitly skipped.
  assert.equal((await getProcessedDocNumbers(['DOC-1', 'DOC-2', 'DOC-3'])).size, 0);
  await recordProcessed({ docNumber: 'DOC-2', amountTetri: 500, date: '16.09.2026', comment: 'x', topupId: 1 });
  await recordProcessed({ docNumber: 'DOC-1', amountTetri: 3000, date: '11.09.2026', comment: 'skipped by admin', topupId: null });
  await recordProcessed({ docNumber: 'DOC-2', amountTetri: 500, date: '16.09.2026', comment: 'x', topupId: 1 }); // re-recording is a safe no-op
  const processed = await getProcessedDocNumbers(['DOC-1', 'DOC-2', 'DOC-3', 'DOC-does-not-exist']);
  assert.deepEqual([...processed].sort(), ['DOC-1', 'DOC-2']);

  const secondPass = matchCredits(topups, credits, processed);
  assert.equal(secondPass.skipped, 2); // DOC-1's and DOC-2's credit rows
  assert.equal(secondPass.topups.find(t => t.id === 1).statementMatch, undefined); // DOC-2 no longer offered
  assert.equal(secondPass.unmatched.some(c => c.docNumber === 'DOC-1'), false);
  assert.equal(secondPass.matched, 2); // AAAA (DOC-3) and E249D9E0F0E7 (DOC-5) still fresh

  console.log('PASS bank statement: extracts credit rows with a reference (ignores debits, no-reference and case), normalizes reference case, rejects a file with no header row, formats real Excel dates, matches against pending top-ups only, surfaces unmatched rows for manual assignment, dedups already-processed doc numbers across re-uploads.');
})().catch(error => { console.error(error); process.exitCode = 1; });

async function buildGarbage() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(['not', 'a', 'bank', 'statement']);
  return wb.xlsx.writeBuffer();
}
