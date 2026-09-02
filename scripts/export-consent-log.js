require('dotenv').config();
const pool = require('../src/config/db');
const consentLog = require('../src/services/consentLog.service');

// Выгрузка журнала согласий на SMS для официального ответа регулятору (PDPS) или
// SMS-оперетору. Печатает JSON в stdout.
//
//   node scripts/export-consent-log.js +9955XXXXXXXX
//   node scripts/export-consent-log.js --master 42
//   node scripts/export-consent-log.js +9955XXXXXXXX > consent_9955XXXXXXXX.json

async function main() {
  const [arg1, arg2] = process.argv.slice(2);

  if (!arg1) {
    console.error('Usage: node scripts/export-consent-log.js <phone> | --master <id>');
    process.exit(1);
  }

  let report;
  if (arg1 === '--master') {
    const id = parseInt(arg2, 10);
    if (!Number.isInteger(id)) {
      console.error('--master requires a numeric master id');
      process.exit(1);
    }
    report = await consentLog.exportForMaster(id);
  } else {
    report = await consentLog.exportForPhone(arg1);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
