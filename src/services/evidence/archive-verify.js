#!/usr/bin/env node
// Самостоятельная проверка архива доказательств Xtender. Нужен только Node.js (18+), без интернета и без Xtender.
// Запуск в папке распакованного архива:  node verify.js
// Что проверяется:
//   1. SHA-256 каждого файла совпадает с integrity.json.
//   2. Записи журнала, выданные целиком, дают тот же отпечаток звена, что записан в цепочке.
//   3. Звенья цепочки идут подряд: каждое ссылается на отпечаток предыдущего.
//   4. Отпечатки с метками времени совпадают со звеньями цепочки; для каждой метки печатается команда openssl,
//      которой проверяется подпись внешней службы времени.
// Отпечаток звена: SHA-256( отпечаток предыдущего звена + "|" + канонический JSON записи ). Канонический JSON:
// ключи по алфавиту на всех уровнях, числа строкой, null для пустых значений, время — строка ISO в UTC.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, name));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (typeof value === 'number' || typeof value === 'bigint') return JSON.stringify(String(value));
  return JSON.stringify(value);
}
const link = (prev, row) => sha256(Buffer.from(prev + '|' + canonical(row), 'utf8'));

let failures = 0;
const fail = (text) => { failures += 1; console.log('  НЕ СОШЛОСЬ / ვერ დადასტურდა: ' + text); };

console.log('1. Файлы / ფაილები');
const integrity = JSON.parse(read('integrity.json'));
let files = 0;
for (const [name, hash] of Object.entries(integrity.files)) {
  files += 1;
  let actual = null;
  try { actual = sha256(read(name)); } catch (_) { fail(name + ': файла нет'); continue; }
  if (actual !== hash) fail(name + ': файл изменён');
}
console.log(`   проверено файлов: ${files}`);

console.log('2. Записи журнала / ჟურნალის ჩანაწერები');
const records = JSON.parse(read('data/journal-records.json')).records;
const chain = JSON.parse(read('integrity/chain-links.json'));
const bySeq = new Map(chain.links.map((item) => [String(item.seq), item]));
let full = 0;
let partial = 0;
for (const record of records) {
  if (!record.chain) continue;
  const item = bySeq.get(String(record.chain.seq));
  if (!item || item.row_hash !== record.chain.row_hash || item.prev_hash !== record.chain.prev_hash) fail(`запись #${record.log_id}: звено не совпадает с цепочкой`);
  if (record.independently_verifiable) {
    full += 1;
    if (link(record.chain.prev_hash, record.row) !== record.chain.row_hash) fail(`запись #${record.log_id}: содержимое не даёт записанный отпечаток`);
  } else partial += 1;
}
console.log(`   пересчитано целиком: ${full}; со скрытыми полями (проверены Xtender при выгрузке, см. integrity.json): ${partial}`);

console.log('3. Цепочка / ჯაჭვი');
for (let i = 1; i < chain.links.length; i += 1) {
  if (chain.links[i].prev_hash !== chain.links[i - 1].row_hash) fail(`звено ${chain.links[i].seq} не ссылается на звено ${chain.links[i - 1].seq}`);
}
console.log(`   звеньев подряд: ${chain.links.length} (с ${chain.from_seq} по ${chain.to_seq})`);

console.log('4. Метки времени / დროის ნიშნულები');
const anchorFiles = fs.existsSync(path.join(dir, 'anchors')) ? fs.readdirSync(path.join(dir, 'anchors')).filter((file) => file.endsWith('.json')).sort() : [];
if (!anchorFiles.length) console.log('   отпечатков с метками времени в архиве нет (см. missing.json)');
for (const name of anchorFiles) {
  const anchor = JSON.parse(read('anchors/' + name));
  const item = bySeq.get(String(anchor.chain_seq));
  if (!item) { console.log(`   ${name}: звено ${anchor.chain_seq} вне выданного отрезка цепочки`); continue; }
  if (item.row_hash !== anchor.chain_head) fail(`${name}: отпечаток не совпадает со звеном ${anchor.chain_seq}`);
  if (anchor.tsa_file) {
    console.log(`   ${name}: звено ${anchor.chain_seq}, служба ${anchor.tsa_url}, время ${anchor.tsa_time}`);
    console.log(`     openssl ts -verify -in anchors/${anchor.tsa_file} -digest ${anchor.chain_head} -CAfile <корневой сертификат службы>`);
  } else console.log(`   ${name}: звено ${anchor.chain_seq}, без внешней метки времени (${anchor.sent_to ? 'отправлен в ' + anchor.sent_to : 'только в базе'})`);
}

console.log(failures ? `\nИТОГ: найдено расхождений: ${failures}` : '\nИТОГ: расхождений нет / შეუსაბამობა არ არის');
process.exitCode = failures ? 1 : 0;
