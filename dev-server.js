process.env.NODE_ENV = 'development';
process.env.PORT = process.env.PORT || '3000';
process.env.DOMAIN = 'localhost:' + process.env.PORT;
// schema.sql is already applied below via pg-mem's native API; running it again through
// app.js's own migration-on-boot (wire-protocol path) hits an unrelated pg-mem parser limit.
process.env.SKIP_DB_MIGRATIONS = '1';

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

const VEHICLE_SIZES = ['L', 'XL', 'XXL'];

async function seedMasters() {
  let transportIndex = 0;
  for (let i = 0; i < 50; i++) {
    const template = TEMPLATES[i % TEMPLATES.length];
    const vehicleType = template.vehicleTypes[i % template.vehicleTypes.length];
    const name = `${NAMES[i % NAMES.length]} ${i + 1}`;
    const phone = `+9955${(10000000 + i).toString()}`;

    let vehicleSize = null;
    let isFlatbed = false;
    if (template.category === 'transport') {
      vehicleSize = VEHICLE_SIZES[transportIndex % VEHICLE_SIZES.length];
      isFlatbed = transportIndex % 4 === 0;
      transportIndex++;
    }

    const isSubscribed = i % 7 !== 0;
    const subscriptionUntil = i % 11 === 0 ? new Date(Date.now() - 24 * 60 * 60 * 1000) : null;
    await fakePool.query(
      `INSERT INTO masters (name, phone, category, vehicle_type, vehicle_size, price_text, description, is_active, is_flatbed, is_subscribed, subscription_until, balance_tetri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, 10000)
       ON CONFLICT (phone) DO NOTHING`,
      [name, phone, template.category, vehicleType, vehicleSize, template.price, template.desc, isFlatbed, isSubscribed, subscriptionUntil]
    );
  }
  // На проде миграция master_services/city_id из schema.sql отрабатывает по уже
  // существующим мастерам. Здесь сид идёт ПОСЛЕ schema.sql, поэтому те же два шага
  // прогоняем вручную — иначе у демо-мастеров не будет строк услуг и города.
  await fakePool.query(
    `INSERT INTO master_services (master_id, service_type, attributes)
     SELECT id,
            CASE WHEN category = 'movers' THEN 'movers' ELSE 'van' END,
            (CASE
               WHEN category = 'movers' THEN '{}'
               ELSE '{"size":' || COALESCE('"' || vehicle_size || '"', 'null')
                    || ',"body":"' || CASE WHEN is_flatbed OR category = 'junk' THEN 'flatbed' ELSE 'closed' END || '"}'
             END)::jsonb
     FROM masters
     WHERE category IS NOT NULL
     ON CONFLICT (master_id, service_type) DO NOTHING`
  );
  await fakePool.query(
    `UPDATE masters SET city_id = (SELECT id FROM cities WHERE slug = 'tbilisi') WHERE city_id IS NULL`
  );
  console.log('Seeded 50 demo masters (+ master_services, city_id)');
}

seedMasters().then(() => {
  require(path.join(__dirname, 'src', 'app.js'));
  console.log('DEV PREVIEW MODE: in-memory Postgres + Redis, SMS logged to console.');
  console.log('Open http://localhost:' + process.env.PORT + '/ to preview the catalog + order form.');
});
