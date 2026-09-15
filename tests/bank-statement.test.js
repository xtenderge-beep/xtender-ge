const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseCredits, matchCredits } = require('../src/services/bankStatement.service');

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
function row({ date = '16.09.2026', credit = null, nomination = '', additionalInfo = nomination }) {
  const base = new Array(HEADERS.length).fill(null);
  base[0] = date; base[7] = credit; base[10] = credit; base[25] = nomination; base[11] = nomination; base[26] = additionalInfo;
  return base;
}

(async () => {
  const buffer = await buildStatement([
    row({ date: '11.09.2026', credit: 30, nomination: 'tankhis gadaritskhva' }), // no reference — a real transfer with a generic purpose
    row({ date: '16.09.2026', credit: 5, nomination: 'balansis shevseba, opherta № XT-622D25271A12, 2026-09-15, tankha 10.00 GEL' }), // partial payment
    row({ date: '16.09.2026', credit: 12.5, nomination: 'balansis shevseba, opherta XT-aaaaaaaaaaaa' }), // lowercase reference still matches
    row({ date: '16.09.2026', credit: null, nomination: 'XT-000000000000' }), // debit/no credit — must be ignored
    // Real statement: same row had a DIFFERENT reference in "Nomination" than in
    // "Additional Info" (a stale one left over next to the current one) — both must
    // be picked up, not just whichever column happens to be checked first.
    row({ date: '15.09.2026', credit: 50, nomination: 'balansis shevseba, opherta № XT-622D25271A12, 2026-09-14, tankha 50.00 GEL', additionalInfo: 'balansis shevseba, opherta № XT-E249D9E0F0E7, 2026-09-15, tankha 50.00 GEL' }),
  ]);

  const garbageBuffer = await buildGarbage();
  const credits = await parseCredits(buffer);
  assert.equal(credits.length, 4);
  assert.equal(credits[0].reference, 'XT-622D25271A12');
  assert.equal(credits[0].amountTetri, 500);
  assert.equal(credits[0].date, '16.09.2026');
  assert.equal(credits[1].reference, 'XT-AAAAAAAAAAAA'); // normalized to uppercase
  const lastRowRefs = credits.slice(2).map(c => c.reference).sort();
  assert.deepEqual(lastRowRefs, ['XT-622D25271A12', 'XT-E249D9E0F0E7']);
  assert.ok(credits.slice(2).every(c => c.amountTetri === 5000));

  await assert.rejects(() => parseCredits(garbageBuffer), /Date/);

  const topups = [
    { id: 1, reference: 'XT-622D25271A12', amount_tetri: 1000, status: 'awaiting' },
    { id: 2, reference: 'XT-AAAAAAAAAAAA', amount_tetri: 1250, status: 'received' },
    { id: 3, reference: 'XT-622D25271A12', amount_tetri: 1000, status: 'credited' }, // same reference, already paid — must not re-match
    { id: 4, reference: 'XT-NOMATCH00000', amount_tetri: 500, status: 'awaiting' },
    { id: 5, reference: 'XT-E249D9E0F0E7', amount_tetri: 5000, status: 'awaiting' }, // the reference that was hiding in "Additional Info"
  ];
  const result = matchCredits(topups, credits);
  assert.equal(result.totalCredits, 4);
  assert.equal(result.matched, 3);
  assert.equal(result.topups.find(t => t.id === 1).statementMatch.amountTetri, 500);
  assert.equal(result.topups.find(t => t.id === 2).statementMatch.amountTetri, 1250);
  assert.equal(result.topups.find(t => t.id === 3).statementMatch, undefined);
  assert.equal(result.topups.find(t => t.id === 4).statementMatch, undefined);
  assert.equal(result.topups.find(t => t.id === 5).statementMatch.amountTetri, 5000);

  console.log('PASS bank statement: extracts credit rows with a reference (ignores debits, no-reference and case), normalizes reference case, rejects a file with no header row, matches against pending top-ups only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

async function buildGarbage() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(['not', 'a', 'bank', 'statement']);
  return wb.xlsx.writeBuffer();
}
