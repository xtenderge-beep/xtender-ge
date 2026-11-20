// Компании для обзвона (docs/outreach-prospects.md): загрузка списка по API с ключом бота, повтор не дублирует,
// неизвестный код услуги уходит в «другое»; итог звонка; «просил не звонить» — в общий список отказа;
// ссылка только с отметкой «согласился» и только с грузинским номером, описание без номеров; черновик — тот же,
// что у бота (источник owner_call); зарегистрированный номер видно как «исполнитель»; админские страницы рендерятся.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (p, exports) => require.cache[require.resolve(p)] = { exports };
stub('../src/config/db', pool); const redis = new (require('ioredis-mock'))(); stub('../src/config/redis', redis);
const sent = [];
stub('../src/services/sms.service', { sendOtp: async () => { sent.push('otp'); return { providerMessageId: 'x', messageBody: 'code' }; }, sendOrderNotification: async () => { sent.push('sms'); return { ok: true }; } });
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru', translateText: async () => null, translateProviderDescription: async () => null });
stub('../src/services/telegram.service', { notifyModeratorNewMaster: async () => {}, notifyModerator: async () => {}, sendToChat: async () => {}, updateMessage: async () => {} });
process.env.DOMAIN = 'xtender.ge';

const express = require('express'), ejs = require('ejs');
const drafts = require('../src/services/providerDraft.service');
const prospects = require('../src/services/prospect.service');
const admin = require('../src/controllers/prospectAdmin.controller');
const app = express();
app.use(express.json());
app.use('/', require('../src/routes/outreachDraft.routes'));

const COMPANIES = [
  { name: 'avejisgadazidva.ge', phones: '599962596, 599 11 22 33', website: 'https://www.AvejisGadazidva.ge/', services: ['movers', 'transport', 'junk'],
    other_services: ['упаковка'], description: 'ავეჯის გადაზიდვა. დარეკეთ 599 96 25 96', title: 'ავეჯის გადაზიდვა • 599 96 25 96', found_where: 'ka #2' },
  { name: 'boxmove.ge', website: 'boxmove.ge', services: ['movers', 'nope_code'], description: 'Грузчики и вывоз мусора' },
  { name: 'Без контактов' },
];

(async () => {
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const api = (body, key) => fetch(base + '/api/outreach/prospects', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: await r.json() }));
  try {
    assert.equal((await api({ prospects: COMPANIES })).status, 401, 'без ключа нельзя');
    const key = await drafts.issueKey();
    const first = await api({ prospects: COMPANIES, source: 'google_top20' }, key);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual([first.data.created, first.data.updated, first.data.skipped.length], [2, 0, 1]);
    const again = await api({ prospects: COMPANIES.slice(0, 2), source: 'google_top20' }, key);
    assert.deepEqual([again.data.created, again.data.updated], [0, 2], 'повтор по номеру и сайту не дублирует');
    assert.equal((await api({ prospects: [] }, key)).status, 400);

    const { rows, counts, total } = await prospects.list();
    assert.equal(total, 2); assert.equal(counts.new, 2);
    const ad = rows.find(r => r.name === 'avejisgadazidva.ge'), box = rows.find(r => r.name === 'boxmove.ge');
    assert.equal(ad.phone, '+995599962596'); assert.equal(ad.phones_extra, '+995599112233');
    assert.equal(ad.website, 'https://avejisgadazidva.ge', 'сайт приведён к одному виду');
    assert.deepEqual(box.services, ['movers']); assert.ok(box.other_services.includes('nope_code'), 'неизвестный код — в «другое»');
    assert.equal(box.phone, null);

    // Звонки.
    await prospects.logCall(ad.id, { result: 'no_answer', note: 'не взяли' });
    await prospects.logCall(ad.id, { result: 'callback', note: 'после 18:00' });
    let card = await prospects.get(ad.id);
    assert.equal(card.stage, 'callback'); assert.equal(card.calls.length, 2);
    await assert.rejects(prospects.logCall(ad.id, { result: 'bogus' }), /Unknown call result/);

    // Ссылка: без отметки «согласился» — нельзя; без номера — нельзя.
    await assert.rejects(prospects.createLink(ad.id, {}), e => e.code === 'not_confirmed');
    await assert.rejects(prospects.createLink(box.id, { confirmedByOwner: true }), e => e.code === 'invalid_phone');
    const link = await prospects.createLink(ad.id, { confirmedByOwner: true, lang: 'ka' }, { ip: '1.2.3.4' });
    assert.match(link.url, /^https:\/\/xtender\.ge\/c\/[2-9A-Z]{8}$/);
    const draft = (await pool.query('SELECT * FROM provider_drafts WHERE phone = $1', ['+995599962596'])).rows[0];
    assert.equal(draft.source, 'owner_call'); assert.equal(draft.external_id, 'prospect_' + ad.id);
    assert.ok(!/\d{3}\s?\d{2}\s?\d{2}/.test(draft.data.description), 'в описании анкеты нет номера');
    assert.deepEqual(draft.data.services, ['movers', 'van', 'junk'], 'transport → van');
    assert.ok(draft.data.kinds.includes('vehicle'), 'с транспортом — «машина» в подсказке');
    card = await prospects.get(ad.id);
    assert.equal(card.stage, 'link_sent'); assert.equal(card.confirmUrl, link.url);
    const again2 = await prospects.createLink(ad.id, { confirmedByOwner: true });
    assert.equal(again2.url, link.url, 'повторно — та же ссылка'); assert.equal(again2.created, false);
    const agreed = (await pool.query("SELECT * FROM sms_consent_logs WHERE event_type = 'OUTREACH_PHONE_AGREED'")).rows;
    assert.equal(agreed.length, 2); assert.equal(agreed[0].channel, 'phone');
    assert.equal(sent.length, 0, 'сайт ничего не отправил');

    // Компания стала исполнителем — в списке это видно.
    await pool.query("INSERT INTO masters (name, phone, is_active) VALUES ('AG', '+995599962596', true)");
    assert.equal((await prospects.get(ad.id)).stage, 'registered');
    await assert.rejects(prospects.createLink(ad.id, { confirmedByOwner: true }), e => e.code === 'already_registered');

    // «Просил не звонить» → общий список отказа.
    await api({ prospects: [{ name: 'gadaitane.ge', phone: '571030763', services: ['movers'], description: 'ავეჯის გადაზიდვა' }] }, key);
    const gad = (await prospects.list({ q: 'gadaitane' })).rows[0];
    await prospects.logCall(gad.id, { result: 'do_not_call', note: 'не интересно, не звонить' }, {});
    assert.equal((await drafts.status('+995571030763')).status, 'opted_out');
    assert.equal((await prospects.get(gad.id)).stage, 'do_not_call');
    await assert.rejects(prospects.createLink(gad.id, { confirmedByOwner: true }), e => e.code === 'opted_out');
    const optLog = (await pool.query("SELECT metadata FROM sms_consent_logs WHERE event_type = 'OUTREACH_OPT_OUT'")).rows[0];
    assert.equal((typeof optLog.metadata === 'string' ? JSON.parse(optLog.metadata) : optLog.metadata).actor, 'admin');

    // Админские страницы рендерятся.
    const render = (view, locals) => ejs.renderFile(path.join(__dirname, '../src/views/admin', view + '.ejs'), { csrfToken: 't', active: 'outreach', adminNavCounts: {}, ...locals });
    const listData = await prospects.list();
    const listHtml = await render('outreach-prospects', { ...listData, filter: { stage: '', service: '', q: '' }, stages: Object.keys(admin.STAGE_LABELS), labels: admin.STAGE_LABELS, services: await drafts.services() });
    assert.ok(listHtml.includes('boxmove.ge') && listHtml.includes('Подтвердил — исполнитель'));
    await prospects.remove(gad.id);
    const fresh = (await api({ prospects: [{ name: 'davitiani.ge', phone: '597064296', services: ['junk'], description: 'ნაგვის გატანა' }] }, key)).data;
    assert.equal(fresh.created, 1);
    const dav = (await prospects.list({ q: 'davitiani' })).rows[0];
    await prospects.createLink(dav.id, { confirmedByOwner: true });
    const cardData = await prospects.get(dav.id);
    const cardHtml = await render('outreach-prospect', { p: cardData, labels: admin.STAGE_LABELS, results: { no_answer: '', callback: '', declined: '', do_not_call: '', note: '', agreed: 'Согласился' }, flash: {},
      message: { ka: 'ka ' + cardData.confirmUrl, ru: 'ru ' + cardData.confirmUrl } });
    assert.ok(cardHtml.includes('wa.me/995597064296') && cardHtml.includes(cardData.confirmUrl));
    console.log('outreach-prospects: OK');
  } finally { server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
