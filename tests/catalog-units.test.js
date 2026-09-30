// Единицы в бейджах и фильтрах каталога переводятся: на грузинской странице стояли «см», «т», «м³».
const assert=require('node:assert/strict');
const {badges,view}=require('../src/services/category.service');
const junk={slug:'junk'},attrs={volume_m3:2,body_length_cm:310,body_width_cm:200,side_height_cm:40,payload_t:3};
assert.deepEqual(badges(junk,attrs,'ka'),['მოცულობა: 2+ მ³','ძარა: 310×200×40 სმ','ტვირთამწეობა: 3 ტ']);
assert.deepEqual(badges(junk,attrs,'en'),['Volume: 2+ m³','Body: 310×200×40 cm','Payload: 3 t']);
assert.deepEqual(badges(junk,attrs,'ru'),['Объём: 2+ м³','Кузов: 310×200×40 см','Грузоподъёмность: 3 т']);
const tow={slug:'tow',name_ru:'Эвакуатор',fields:[{key:'max_tonnage',input:'number',unit:'т'},{key:'note',input:'number',unit:'шт'}]};
assert.equal(view(tow,'ka').fields[0].unit,'ტ');assert.equal(view(tow,'en').fields[0].unit,'t');assert.equal(view(tow,'ru').fields[0].unit,'т');
assert.equal(view(tow,'ka').fields[1].unit,'шт','unknown units are shown as entered');
assert.deepEqual(badges(tow,{max_tonnage:8},'ka'),['8 ტ']);
console.log('PASS: catalog units in ka/en/ru for junk badges, configurable fields and unknown units');
