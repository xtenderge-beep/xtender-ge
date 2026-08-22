require('dotenv').config();
const pool = require('../src/config/db');

const TEMPLATES = [
  { category: 'transport', vehicleTypes: ['Ford Transit (высокий кузов)', 'Mercedes Sprinter Max (4.2m)', 'Газель 4м с гидробортом', 'Ford Transit (длинная база)'], price: 'от 60 GEL / рейс', desc: 'Чистый крытый фургон. Перевозка мебели, коробок, бытовой техники.' },
  { category: 'movers', vehicleTypes: ['Бригада грузчиков (2-4 чел)', 'Грузчик-одиночка'], price: 'от 30 GEL / час', desc: 'Подъем и спуск мебели без лифта, разгрузка фур, переноска тяжестей.' },
  { category: 'junk', vehicleTypes: ['ЗИЛ / Самосвал', 'Вывоз мешками'], price: 'от 70 GEL / рейс', desc: 'Вынос строительного мусора в мешках, старой мебели и демонтированного лома.' },
];

const NAMES = ['Давид', 'Гиорги', 'Нико', 'Леван', 'Заза', 'Тенгиз', 'Бека', 'Отар', 'Ираклий', 'Вахтанг', 'Сандро', 'Торнике'];

async function seed() {
  for (let i = 0; i < 50; i++) {
    const template = TEMPLATES[i % TEMPLATES.length];
    const vehicleType = template.vehicleTypes[i % template.vehicleTypes.length];
    const name = `${NAMES[i % NAMES.length]} ${i + 1}`;
    const phone = `+9955${(10000000 + i).toString()}`;

    await pool.query(
      `INSERT INTO masters (name, phone, category, vehicle_type, price_text, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (phone) DO NOTHING`,
      [name, phone, template.category, vehicleType, template.price, template.desc]
    );
  }

  console.log('Seeded 50 masters');
  await pool.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
