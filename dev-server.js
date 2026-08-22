process.env.NODE_ENV = 'development';
process.env.PORT = process.env.PORT || '3000';
process.env.DOMAIN = 'localhost:' + process.env.PORT;

const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'ioredis') request = 'ioredis-mock';
  return originalResolve.call(this, request, ...args);
};

const db = newDb();
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.public.none(schema);

const { Pool } = db.adapters.createPg();
const fakePool = new Pool();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    return { Pool: function () { return fakePool; } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const TEMPLATES = [
  { category: 'transport', vehicleTypes: ['Ford Transit (высокий кузов)', 'Mercedes Sprinter Max (4.2m)', 'Газель 4м с гидробортом', 'Ford Transit (длинная база)'], price: 'от 60 GEL / рейс', desc: 'Чистый крытый фургон. Перевозка мебели, коробок, бытовой техники.' },
  { category: 'movers', vehicleTypes: ['Бригада грузчиков (2-4 чел)', 'Грузчик-одиночка'], price: 'от 30 GEL / час', desc: 'Подъем и спуск мебели без лифта, разгрузка фур, переноска тяжестей.' },
  { category: 'junk', vehicleTypes: ['ЗИЛ / Самосвал', 'Вывоз мешками'], price: 'от 70 GEL / рейс', desc: 'Вынос строительного мусора в мешках, старой мебели и демонтированного лома.' },
];
const NAMES = ['Давид', 'Гиорги', 'Нико', 'Леван', 'Заза', 'Тенгиз', 'Бека', 'Отар', 'Ираклий', 'Вахтанг', 'Сандро', 'Торнике'];

async function seedMasters() {
  for (let i = 0; i < 50; i++) {
    const template = TEMPLATES[i % TEMPLATES.length];
    const vehicleType = template.vehicleTypes[i % template.vehicleTypes.length];
    const name = `${NAMES[i % NAMES.length]} ${i + 1}`;
    const phone = `+9955${(10000000 + i).toString()}`;
    await fakePool.query(
      `INSERT INTO masters (name, phone, category, vehicle_type, price_text, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (phone) DO NOTHING`,
      [name, phone, template.category, vehicleType, template.price, template.desc]
    );
  }
  console.log('Seeded 50 demo masters');
}

seedMasters().then(() => {
  require(path.join(__dirname, 'src', 'app.js'));
  console.log('DEV PREVIEW MODE: in-memory Postgres + Redis, SMS logged to console.');
  console.log('Open http://localhost:' + process.env.PORT + '/ to preview the catalog + order form.');
});
