const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('pg-mem').newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (error) { backup.restore(); throw error; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
require.cache[require.resolve('../src/services/manager.service')] = { exports: {
  listActiveModerators: async () => [], listHeadModerators: async () => [],
} };
const axios = require('axios');
const post = axios.post;
const previousToken = process.env.TELEGRAM_BOT_TOKEN;
const previousChat = process.env.TELEGRAM_MODERATOR_CHAT_ID;
const previousMode = process.env.NODE_ENV;
const calls = [];
axios.post = async (url, body) => { calls.push({ url, body }); return { data: { result: { message_id: 1 } } }; };
process.env.TELEGRAM_BOT_TOKEN = 'test-only';
process.env.TELEGRAM_MODERATOR_CHAT_ID = '777';
process.env.NODE_ENV = 'test';

(async () => {
  const master = await require('../src/services/master.service').registerMaster({
    name: 'Демо', phone: '+995500000777', serviceType: 'movers',
    cityIds: [1, 2], spokenLanguages: ['ka', 'ru'],
  });
  const telegram = require('../src/services/telegram.service');
  await telegram.notifyModeratorNewMaster(master);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Города: Тбилиси, Батуми/);
  assert.match(calls[0].body.text, /Языки: Грузинский, Русский/);
  assert.match(calls[0].body.reply_markup.inline_keyboard[0][0].url, new RegExp('/admin/masters/' + master.id + '$'));
  const report = telegram.buildMessageText({ status: 'new', description: 'Перевозка', district_name: 'Центр', phone: '+995500000888', target_categories: [] },
    ['Грузчики\nВыбрано: 2 · принято: 2'], { view: 1, call: 1, whatsapp: 0, contacted: 1 }, { cityName: 'Батуми' });
  assert.match(report, /Город: Батуми/);
  assert.match(report, /Нажали хотя бы один контакт: 1/);
  console.log('PASS: Telegram moderator preview includes all work cities, spoken languages, profile link, order city and observed actions');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  axios.post = post;
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  if (previousChat === undefined) delete process.env.TELEGRAM_MODERATOR_CHAT_ID; else process.env.TELEGRAM_MODERATOR_CHAT_ID = previousChat;
  if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
});
