// Рассылки исполнителям (/admin/outreach): черновик со своим текстом каждому → отправка кладёт текст в чат поддержки кабинета,
// шлёт SMS-уведомление латиницей (и Telegram, если привязан) → «Открыл», когда кабинет показал блок поддержки → «Ответил»
// по первому сообщению исполнителя после отправки. Повторная отправка ничего не дублирует; кабинет показывает плашку
// о новом сообщении, пока его не увидели.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), ejs = require('ejs'), vm = require('vm');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (p, exports) => require.cache[require.resolve(p)] = { exports };
stub('../src/config/db', pool); const redis = new (require('ioredis-mock'))(); stub('../src/config/redis', redis);
const sms = [], telegram = [];
let failPhone = null;
stub('../src/services/sms.service', { sendOrderNotification: async (phone, text, context) => {
  if (phone === failPhone) throw new Error('SMS gateway did not confirm acceptance');
  sms.push({ phone, text, context }); return { ok: true };
} });
stub('../src/services/telegram.service', { sendToChat: async (chat, text) => { telegram.push({ chat, text }); },
  forwardSupportMessage: async () => null, updateMessage: async () => {}, notifyModerator: async () => {} });
process.env.OUTREACH_PAUSE_MS = '0';
const outreach = require('../src/services/outreach.service');
const support = require('../src/services/support.service');
const cabinet = require('../src/controllers/master.controller');
const { translate, clientStrings } = require('../src/config/i18n');

const provider = async (id, phone, lang, extra = '') => (await pool.query(
  `INSERT INTO masters(id, name, phone, language, master_token, is_active${extra ? ', ' + extra.split('=')[0] : ''})
   VALUES($1, $2, $3, $4, $5, true${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING *`,
  [id, 'Мастер ' + id, phone, lang, 'tok-' + id])).rows[0];
const rejects = async (fn, pattern) => { await assert.rejects(fn, err => pattern.test(err.message)); };

(async () => {
  await provider(11, '+995500000011', 'ka');
  await provider(12, '+995500000012', 'ru', 'telegram_id=777');
  await provider(13, '+995500000013', 'en');
  await provider(14, '+995500000014', 'ru', 'is_banned=true');

  // Разбор получателей и проверки черновика.
  assert.deepEqual(outreach.parseRecipients('#11\nპირველი\n---\n# 12\nВторой\nстрока\n---\n'),
    { items: [{ masterId: 11, body: 'პირველი' }, { masterId: 12, body: 'Второй\nстрока' }], errors: [] });
  const SMS = 'Xtender: you have a message from support. Log in and reply: https://xtender.ge/master#support';
  await rejects(() => outreach.create({ title: 'x', smsText: 'Xtender: у вас сообщение', recipients: '#11\nтекст' }), /латиница/);
  await rejects(() => outreach.create({ title: 'x', smsText: SMS, recipients: '#11\na\n---\n#11\nb' }), /дважды/);
  await rejects(() => outreach.create({ title: 'x', smsText: SMS, recipients: '#14\nтекст' }), /#14/);
  await rejects(() => outreach.create({ title: 'x', smsText: SMS, recipients: 'без номера' }), /Не разобрал/);

  const campaign = await outreach.create({ title: 'Уточняем описания', smsText: SMS,
    recipients: '#11\nგამარჯობა! კითხვა.\n---\n#12\nЗдравствуйте! Вопрос.\n---\n#13\nHello! Question.' });
  let view = await outreach.get(campaign.id);
  assert.deepEqual([view.stats.total, view.stats.draft, view.stats.sent], [3, 3, 0]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM support_messages')).rows[0].n, 0, 'черновик ничего не отправляет');

  // Правка и «убрать из рассылки» до отправки; пробное SMS — тем же текстом.
  const [r11, r12, r13] = view.rows;
  await outreach.updateBody(campaign.id, r11.id, 'გამარჯობა! შესწორებული კითხვა.');
  await outreach.setSkipped(campaign.id, r13.id, true);
  assert.equal(await outreach.sendTest(campaign.id, '599 12 34 56'), '+995599123456');
  assert.deepEqual([sms[0].phone, sms[0].text, sms[0].context.category], ['+995599123456', SMS, 'outreach_test']);
  await rejects(() => outreach.sendTest(campaign.id, '12'), /номер/);
  sms.length = 0;

  // Отправка: кабинет + SMS (+ Telegram у №12). У №11 шлюз отказал — сообщение в кабинете есть, SMS помечено ошибкой.
  failPhone = '+995500000011';
  const run = await outreach.start(campaign.id);
  assert.equal(run.count, 2);
  await run.done;
  await rejects(() => outreach.start(campaign.id), /уже отправлена/);
  await rejects(() => outreach.updateBody(campaign.id, r12.id, 'другое'), /уже отправлено/);
  assert.deepEqual(sms.map(s => [s.phone, s.text, s.context.masterId, s.context.category]), [['+995500000012', SMS, 12, 'outreach']]);
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].chat, 777);
  assert.ok(telegram[0].text.startsWith('💬 Сообщение от поддержки Xtender:\nЗдравствуйте! Вопрос.'));
  view = await outreach.get(campaign.id);
  const row = id => view.rows.find(r => r.master_id === id);
  assert.deepEqual([row(11).status, row(11).sms_status, row(12).sms_status, row(12).telegram_sent, row(13).status], ['sent', 'failed', 'accepted', true, 'skipped']);
  assert.match(row(11).sms_error, /did not confirm/);
  assert.deepEqual([view.stats.total, view.stats.sent, view.stats.smsAccepted, view.stats.smsFailed, view.stats.seen, view.stats.replied], [2, 2, 1, 1, 0, 0]);
  const thread11 = await support.listForMaster(11);
  assert.deepEqual(thread11.map(m => [m.sender, m.body]), [['moderator', 'გამარჯობა! შესწორებული კითხვა.']]);

  // Кабинет: плашка о новом сообщении, пока его не увидели; отметка «Открыл».
  const render = async (masterId, lang) => {
    const master = (await pool.query('SELECT * FROM masters WHERE id=$1', [masterId])).rows[0];
    const html = await ejs.renderFile(path.join(__dirname, '../src/views/master-status.ejs'), {
      lang, t: translate(lang), clientStrings: clientStrings(lang), currentPath: '/master', master: { ...master, balance_tetri: 0, created_at: new Date(), category: 'movers' },
      badToken: false, reviews: [], activity: {}, history: [], leads: [], supportMessages: await support.listForMaster(masterId), receipts: [], topups: [],
      leadPriceTetri: 50, catalogCallPriceTetri: 50, payment: {}, botUsername: 'test' });
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
    return html;
  };
  let html = await render(11, 'ka');
  // Вопрос без ответа — первым на экране, с полем ответа; показ сразу отмечает «Открыл».
  const shown = h => /id="supportPending"\s+data-pending-ids/.test(h);
  assert.ok(shown(html) && html.includes(translate('ka')('master_support_pending_title')));
  assert.ok(html.indexOf('id="supportPending"') < html.indexOf('data-tab-btn='), 'вопрос выше вкладок');
  assert.ok(html.includes('გამარჯობა! შესწორებული კითხვა.') && html.includes('id="supportPendingForm"'));
  assert.ok(html.includes("fetch('/api/master/' + SUPPORT_TOKEN + '/support/seen'") && html.includes('if (true)'));
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; return this; } };
  await cabinet.markSupportSeen({ params: { token: 'tok-11' } }, res);
  assert.deepEqual(res.data, { success: true, marked: 1 });
  html = await render(11, 'ka');
  assert.ok(shown(html) && html.includes('if (false)'), 'открыл, но не ответил: вопрос остаётся, повторной отметки нет');
  await cabinet.markSupportSeen({ params: { token: 'nope' } }, res);
  assert.equal(res.statusCode, 404);

  // Ответ исполнителя в поддержке — «Ответил» с текстом; сообщения до рассылки ответом не считаются.
  await support.forwardQuestion({ id: 12, name: 'Мастер 12' }, 'У меня Ford Transit, закрытый кузов.');
  view = await outreach.get(campaign.id);
  assert.deepEqual([view.stats.seen, view.stats.replied], [1, 1]);
  assert.equal(row(11).reply, null);
  assert.equal(view.rows.find(r => r.master_id === 12).reply.body, 'У меня Ford Transit, закрытый кузов.');
  const after = await render(12, 'ru');
  assert.ok(after.includes('id="supportPending" hidden') && !shown(after), 'после ответа вопрос сверху скрыт');
  assert.ok(after.includes("'/support/pending'"), 'открытый кабинет сам проверяет новые вопросы');

  // Опрос кабинета: вопрос без ответа — список; после ответа — пусто.
  const pendingRes = { set() { return this; }, status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; return this; } };
  await cabinet.supportPending({ params: { token: 'tok-11' } }, pendingRes);
  assert.deepEqual(pendingRes.data.messages.map(m => m.body), ['გამარჯობა! შესწორებული კითხვა.']);
  await cabinet.supportPending({ params: { token: 'tok-12' } }, pendingRes);
  assert.deepEqual(pendingRes.data.messages, []);

  // «Написать» из «Сейчас на сайте»: рассылка на одного, без SMS по умолчанию; с галочкой — с SMS.
  sms.length = 0; telegram.length = 0;
  const quick = await outreach.sendOne({ masterId: 13, body: 'Hello from live' });
  let one = await outreach.get(quick.id);
  assert.match(quick.title, /^Вручную: #13 · Мастер 13 · /);
  assert.deepEqual([one.rows[0].status, one.rows[0].sms_status, sms.length], ['sent', 'off', 0]);
  await cabinet.supportPending({ params: { token: 'tok-13' } }, pendingRes);
  assert.deepEqual(pendingRes.data.messages.map(m => m.body), ['Hello from live']);
  const withSms = await outreach.sendOne({ masterId: 13, body: 'Второе', withSms: true });
  one = await outreach.get(withSms.id);
  assert.deepEqual([one.rows[0].sms_status, sms.length, sms[0].context.category], ['accepted', 1, 'outreach']);
  await rejects(() => outreach.sendOne({ masterId: 14, body: 'x' }), /заблокирован/);
  await rejects(() => outreach.sendOne({ masterId: 13, body: '  ' }), /от 1 до 2000/);
  assert.ok((await ejs.renderFile(path.join(__dirname, '../src/views/admin/outreach-detail.ejs'), { csrfToken: 'x', navCounts: {}, ...(await outreach.get(quick.id)), filter: 'all', error: null, notice: null })).includes('без SMS'));

  // Экраны админки рендерятся: список, новая, рассылка со всеми фильтрами.
  const admin = (file, data) => ejs.renderFile(path.join(__dirname, '../src/views/admin/' + file), { csrfToken: 'x', navCounts: {}, ...data });
  assert.ok((await admin('outreach.ejs', { campaigns: await outreach.list() })).includes('ответили: <b>1</b>'));
  assert.ok((await admin('outreach-new.ejs', { error: null, input: { title: '', smsText: SMS, recipients: '' } })).includes('Сохранить черновик'));
  for (const filter of ['all', 'seen', 'unseen', 'waiting', 'replied', 'failed']) {
    const page = await admin('outreach-detail.ejs', { ...view, filter, error: null, notice: null });
    if (filter === 'replied') assert.ok(page.includes('Ford Transit') && !page.includes('#11 · '));
    if (filter === 'failed') assert.ok(page.includes('#11 · ') && page.includes('SMS ✗ ошибка'));
  }
  console.log('PASS: outreach draft → cabinet + SMS + Telegram, gateway failure recorded, no double send, seen and reply tracked, cabinet banner, admin screens rendered.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => redis.disconnect());
