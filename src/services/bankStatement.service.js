const ExcelJS = require('exceljs');

// Our own reference format (see topup.service.js: 'XT-' + 6 random bytes as uppercase
// hex). Banks pass the payer's free-text payment purpose through mostly unchanged, so
// this substring usually survives even when the rest of the text gets transliterated
// or truncated.
const REFERENCE_RE = /XT-([0-9a-f]{12})/i;

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object' && value.text) return String(value.text);
  return String(value);
}
function cellAmount(value) {
  const n = Number(cellText(value).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Bank of Georgia business statement export: a handful of title/metadata rows, then a
// header row naming the columns, then one row per ledger entry. We locate the header
// row by content (it has a "Date" cell) instead of assuming a fixed row number, since
// the exact number of leading rows has already varied between exports.
async function parseCredits(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('Не удалось прочитать файл — это точно .xlsx выписка из банка?');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Файл пуст или повреждён');

  let headerRow = null;
  let columns = null;
  sheet.eachRow((row) => {
    if (headerRow) return;
    const values = row.values;
    if (!Array.isArray(values) || !values.some(v => cellText(v).trim() === 'Date')) return;
    headerRow = row.number;
    columns = {};
    values.forEach((v, i) => { const name = cellText(v).trim(); if (name) columns[name] = i; });
  });
  if (!headerRow) throw new Error('Не найдена строка заголовков (нет колонки "Date") — это точно выписка из банка?');

  const dateCol = columns['Date'];
  const creditCol = columns['Credit In Lari'] || columns['Credit'];
  const textCol = columns['Nomination'] || columns['Entry Comment'] || columns['Additional Info'];
  if (!dateCol || !creditCol || !textCol) throw new Error('В выписке не хватает нужных колонок (Date, Credit In Lari, Nomination)');

  const credits = [];
  sheet.eachRow((row) => {
    if (row.number <= headerRow) return;
    const values = row.values;
    const amount = cellAmount(values[creditCol]);
    if (!amount || amount <= 0) return;
    const text = [values[textCol], values[columns['Entry Comment']]].map(cellText).join(' ');
    const match = text.match(REFERENCE_RE);
    if (!match) return;
    credits.push({
      reference: 'XT-' + match[1].toUpperCase(),
      amountTetri: Math.round(amount * 100),
      date: cellText(values[dateCol]),
      comment: cellText(values[textCol]),
    });
  });
  return credits;
}

// Pairs statement credits with pending invoices by reference. Never touches already
// credited or cancelled top-ups — there's nothing actionable left to confirm there.
function matchCredits(topups, credits) {
  const byReference = new Map();
  for (const credit of credits) if (!byReference.has(credit.reference)) byReference.set(credit.reference, credit);
  let matched = 0;
  const withMatches = topups.map(t => {
    const credit = t.status !== 'credited' ? byReference.get(t.reference) : null;
    if (!credit) return t;
    matched++;
    return { ...t, statementMatch: credit };
  });
  return { topups: withMatches, matched, totalCredits: credits.length };
}

module.exports = { parseCredits, matchCredits };
