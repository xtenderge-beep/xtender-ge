// Анкеты от SMS-бота владельца (docs/outreach-bot-drafts.md): бот создаёт черновик по API → исполнитель открывает
// /c/<token>, правит, ставит галочки (все сняты) → код с сайта → обычная регистрация на модерацию, согласие в журнале,
// бесплатно 60 дней. Плюс: один номер — один черновик, 409 для зарегистрированных и отказавшихся, «Не интересно»
// стирает анкету, истёкший черновик стирается, проба бота даёт тестовый профиль, ключ только в заголовке.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
const stub = (p, exports) => require.cache[require.resolve(p)] = { exports };
stub('../src/config/db', pool); const redis = new (require('ioredis-mock'))(); stub('../src/config/redis', redis);
const codes = [], sms = [], moderator = [];
stub('../src/services/sms.service', {
  sendOtp: async (phone, code) => { codes.push({ phone, code }); return { providerMessageId: 'ref-' + codes.length, messageBody: 'code' }; },
  sendOrderNotification: async (phone, text) => { sms.push({ phone, text }); return { ok: true }; },
});
stub('../src/services/translation.service', { translateOrder: async () => null, detectLang: () => 'ru', translateText: async () => null, translateProviderDescription: async () => null });
stub('../src/services/telegram.service', { notifyModeratorNewMaster: async (m) => { moderator.push(m); }, notifyModerator: async () => {}, sendToChat: async () => {}, updateMessage: async () => {} });
process.env.DOMAIN = 'xtender.ge';

const express = require('express');
const drafts = require('../src/services/providerDraft.service');
const app = express();
app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../src/views'));
app.use(express.json()); app.use(require('cookie-parser')());
app.use((req, res, next) => { const i18n = require('../src/config/i18n'); req.lang = 'ka'; res.locals.lang = 'ka'; res.locals.t = i18n.translate('ka'); next(); });
app.use('/', require('../src/routes/outreachDraft.routes'));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'internal' }); });

let base, key;
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const set of res.headers.getSetCookie()) { const [pair] = set.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data };
};
const botCall = (method, url, body) => call(method, url, body, { Authorization: 'Bearer ' + key });
const pageCall = (url, body) => call('POST', url, body, { Cookie: cookieHeader() });

const DRAFT = {
  phone: '+995597749378', name: 'Zurab Kvrivishvili', type: 'master', services: ['movers'], other_services: ['Котлы и отопление'],
  description: 'Укладка плитки и керамогранита, ванные под ключ.', experience: '12 лет', city: 'Тбилиси', districts: ['Сабуртало', 'Ваке'],
  languages: ['ka', 'ru'], has_vehicle: false, lang: 'ru', source: 'fb_group_remont', external_id: 'sup_000123', provider_agreed: true,
};

(async () => {
  const server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port;
  try {
    // Ключ: без него 401, в адресе — 400, выпуск нового гасит прежний.
    assert.equal((await call('GET', '/api/outreach/services')).status, 401);
    const first = await drafts.issueKey();
    key = await drafts.issueKey();
    assert.equal((await call('GET', '/api/outreach/services', undefined, { Authorization: 'Bearer ' + first })).status, 401, 'прежний ключ не работает');
    assert.equal((await call('GET', '/api/outreach/services?key=' + key, undefined, { Authorization: 'Bearer ' + key })).status, 400);
    const services = await botCall('GET', '/api/outreach/services');
    assert.equal(services.status, 200);
    assert.ok(services.data.some(s => s.code === 'movers' && s.name.ka && s.name.ru && s.name.en));
    assert.deepEqual((await botCall('GET', '/api/outreach/cities')).data.map(c => c.slug), ['tbilisi']);

    // Проверка полей.
    const bad = async (patch, error, status = 400) => {
      const r = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, ...patch });
      assert.equal(r.status, status, JSON.stringify(r.data)); assert.equal(r.data.error, error);
    };
    await bad({ provider_agreed: undefined }, 'provider_not_agreed');
    await bad({ phone: '+7 900 000 00 00' }, 'invalid_phone');
    await bad({ services: ['nope'] }, 'unknown_service');
    await bad({ services: [], other_services: [] }, 'missing_field');
    await bad({ city: 'Батуми' }, 'unknown_city');
    await bad({ description: 'Звоните 599 12 34 56' }, 'description_has_phone');
    await bad({ lang: 'de' }, 'invalid_field');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_drafts')).rows[0].n, 0);

    // Создание: короткая ссылка, сайт ничего не отправляет. Повтор с тем же номером — тот же черновик.
    const created = await botCall('POST', '/api/outreach/drafts', DRAFT);
    assert.equal(created.status, 201);
    assert.match(created.data.confirm_url, /^https:\/\/xtender\.ge\/c\/[2-9A-HJKMNP-Z]{8}$/);
    assert.ok(created.data.confirm_url.replace('https://', '').length <= 25);
    assert.equal(created.data.status, 'draft');
    assert.equal(new Date(created.data.expires_at) - Date.now() > 13.9 * 864e5, true);
    assert.equal(codes.length + sms.length, 0, 'при создании черновика сайт ничего не шлёт');
    const again = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '597 74 93 78', description: 'Плитка, ванные под ключ, сантехника.' });
    assert.equal(again.status, 200);
    assert.deepEqual([again.data.draft_id, again.data.confirm_url], [created.data.draft_id, created.data.confirm_url]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_drafts')).rows[0].n, 1);
    const patched = await botCall('PATCH', '/api/outreach/drafts/' + created.data.draft_id, { experience: '15 лет' });
    assert.equal(patched.status, 200);
    assert.equal((await botCall('PATCH', '/api/outreach/drafts/' + created.data.draft_id, { phone: '+995500000001' })).data.error, 'invalid_field');
    // «+» в адресе без кодирования приходит пробелом.
    let st = await botCall('GET', '/api/outreach/status?phone=+995597749378');
    assert.deepEqual([st.status, st.data.status, st.data.draft_id], [200, 'draft', created.data.draft_id]);
    assert.equal((await botCall('GET', '/api/outreach/status?phone=+995500000999')).data.status, 'none');

    // Уже зарегистрированный исполнитель — 409.
    await pool.query("INSERT INTO masters (name, phone, is_active) VALUES ('Old', '+995511111111', true)");
    const dup = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995511111111' });
    assert.deepEqual([dup.status, dup.data.error, dup.data.status], [409, 'already_registered', 'active']);

    // Страница: открывается, все галочки сняты, номер частично скрыт; статус «opened».
    const token = created.data.confirm_url.split('/c/')[1];
    let page = await call('GET', '/c/' + token.toLowerCase());
    assert.equal(page.status, 200);
    assert.ok(page.data.includes('Zurab Kvrivishvili') && page.data.includes('+995 597 •• •• 78') && !page.data.includes('597749378'));
    assert.ok(page.data.includes('Плитка, ванные под ключ, сантехника.') && page.data.includes('15 лет') && page.data.includes('Котлы и отопление'));
    for (const id of ['termsCheckbox', 'privacyCheckbox', 'leadSmsCheckbox', 'marketingSmsCheckbox']) assert.match(page.data, new RegExp(`id="${id}" class=`), id + ' без checked');
    assert.match(page.data, /id="confirmButton" type="submit" disabled/);
    assert.ok(page.data.includes('noindex'));
    new (require('vm').Script)(page.data.match(/<script>([\s\S]*?)<\/script>/)[1]);
    assert.equal((await botCall('GET', '/api/outreach/status?phone=%2B995597749378')).data.status, 'opened');
    for (const lang of ['ka', 'en']) {
      const other = await call('GET', `/c/${token}?lang=${lang}`);
      assert.ok(other.data.includes(require('../src/config/provider-draft-copy')[lang].title));
    }
    page = await call('GET', '/c/' + token);
    const csrf = page.data.match(/csrf = "([a-f0-9]{64})"/)[1];
    const digest = page.data.match(/consentDigest = "([a-f0-9]{64})"/)[1];
    const form = { _csrf: csrf, lang: 'ru', name: 'Зураб', services: ['movers'], otherServices: 'котлы, газ', description: 'Плитка и ванные под ключ.',
      experience: '15 лет', cityIds: ['1'], districts: 'Ваке', spokenLanguages: ['ka', 'ru'], termsAccepted: true, privacyAccepted: true,
      leadSmsAccepted: true, marketingSmsAccepted: false, consentDigest: digest };

    // Код: без CSRF — 403; без галочки — 400; номер в описании — 400; иначе код уходит на номер из черновика.
    assert.equal((await call('POST', `/c/${token}/code`, form)).status, 403);
    assert.equal((await pageCall(`/c/${token}/code`, { ...form, termsAccepted: false })).status, 400);
    assert.equal((await pageCall(`/c/${token}/code`, { ...form, description: 'Звоните 599123456' })).status, 400);
    assert.equal((await pageCall(`/c/${token}/code`, { ...form, spokenLanguages: [] })).status, 400);
    assert.equal(codes.length, 0);
    const sent = await pageCall(`/c/${token}/code`, form);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.deepEqual(codes.map(c => c.phone), ['+995597749378']);
    const saved = drafts.json((await pool.query('SELECT data FROM provider_drafts WHERE phone = $1', ['+995597749378'])).rows[0].data, {});
    assert.deepEqual([saved.name, saved.other_services, saved.districts], ['Зураб', ['котлы', 'газ'], ['Ваке']]);

    // Неверный код — отказ; верный — профиль на модерации.
    const wrong = codes[0].code === '1234' ? '4321' : '1234';
    assert.equal((await pageCall(`/c/${token}/confirm`, { _csrf: csrf, lang: 'ru', code: wrong, challengeId: sent.data.challengeId })).status, 400);
    const done = await pageCall(`/c/${token}/confirm`, { _csrf: csrf, lang: 'ru', code: codes[0].code, challengeId: sent.data.challengeId });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.leadSms, true);
    assert.match(done.data.link, /\/master\//);
    const master = (await pool.query("SELECT * FROM masters WHERE phone = '+995597749378'")).rows[0];
    assert.deepEqual([master.name, master.is_active, master.is_subscribed, master.marketing_sms, master.language, master.signup_source, master.is_technical],
      ['Зураб', false, true, false, 'ru', 'fb_group_remont', false]);
    assert.equal(master.description, 'Плитка и ванные под ключ.\n\nОпыт: 15 лет');
    assert.ok(Math.abs(new Date(master.free_until) - Date.now() - 60 * 864e5) < 60000, 'бесплатно 60 дней');
    assert.deepEqual(drafts.json(master.signup_hint, {}).services, ['movers']);
    assert.deepEqual(require('../src/config/providerKinds').of(master), ['worker']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM master_services WHERE master_id = $1', [master.id])).rows[0].n, 0, 'услуги назначает модератор');
    const logs = (await pool.query('SELECT event_type, metadata, terms_version, consent_text_snapshot FROM sms_consent_logs WHERE phone_number = $1 ORDER BY id', ['+995597749378'])).rows;
    const verified = logs.find(l => l.event_type === 'CONSENT_SMS_OTP_VERIFIED');
    const snapshot = drafts.json(verified.metadata, {}).snapshot;
    assert.deepEqual([snapshot.signup_path, snapshot.draft_id, snapshot.choices.lead_sms, snapshot.choices.marketing_sms], ['outreach_draft', created.data.draft_id, true, false]);
    assert.ok(verified.terms_version && snapshot.privacy_version && verified.consent_text_snapshot);
    assert.ok(logs.some(l => l.event_type === 'MASTER_REGISTERED') && logs.some(l => l.event_type === 'LEAD_SMS_OPT_IN'));
    assert.ok(!logs.some(l => l.event_type === 'MARKETING_SMS_OPT_IN'));
    assert.equal(moderator.length, 1);
    assert.ok(require('../src/config/signupHint').linesRu(moderator[0]).some(line => line.includes('fb_group_remont')));
    assert.equal(sms.length, 1, 'SMS о регистрации со ссылкой на кабинет');
    const row = (await pool.query("SELECT * FROM provider_drafts WHERE phone = '+995597749378'")).rows[0];
    assert.deepEqual([row.status, row.master_id, drafts.json(row.data, null)], ['confirmed', master.id, {}]);
    st = await botCall('GET', '/api/outreach/status?phone=995597749378');
    assert.equal(st.data.status, 'confirmed'); assert.ok(st.data.confirmed_at && st.data.free_until);
    assert.equal((await call('GET', '/c/' + token)).data.includes('/master'), true, 'по ссылке — «уже подтверждена»');
    assert.equal((await pageCall(`/c/${token}/code`, form)).status, 409);
    await pool.query('UPDATE masters SET is_active = true WHERE id = $1', [master.id]);
    await pool.query("INSERT INTO master_admin_events (master_id, actor, action) VALUES ($1, 'Администратор', 'approve')", [master.id]);
    assert.equal((await botCall('GET', '/api/outreach/status?phone=%2B995597749378')).data.status, 'active');
    const since = new Date(Date.now() - 3600000).toISOString();
    const changes = await botCall('GET', '/api/outreach/changes?since=' + encodeURIComponent(since));
    assert.deepEqual(changes.data.map(c => [c.phone, c.status]), [['+995597749378', 'active']]);
    assert.equal((await botCall('GET', '/api/outreach/changes?since=вчера')).status, 400);
    assert.equal((await botCall('POST', '/api/outreach/drafts', DRAFT)).data.error, 'already_registered');

    // «Не интересно» со страницы: анкета стёрта, номер в списке отказа, бот получает 409.
    const second = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995522222222' });
    const token2 = second.data.confirm_url.split('/c/')[1];
    const page2 = await call('GET', '/c/' + token2);
    const csrf2 = page2.data.match(/csrf = "([a-f0-9]{64})"/)[1];
    assert.equal((await pageCall(`/c/${token2}/decline`, { _csrf: csrf2 })).status, 200);
    assert.equal((await botCall('GET', '/api/outreach/status?phone=%2B995522222222')).data.status, 'declined');
    assert.deepEqual(drafts.json((await pool.query("SELECT data FROM provider_drafts WHERE phone = '+995522222222'")).rows[0].data, null), {});
    assert.equal((await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995522222222' })).data.error, 'opted_out');
    assert.ok((await call('GET', '/c/' + token2)).data.includes(require('../src/config/provider-draft-copy').ru.declinedTitle));
    assert.ok((await pool.query("SELECT * FROM sms_consent_logs WHERE event_type = 'OUTREACH_OPT_OUT' AND phone_number = '+995522222222'")).rows.length);

    // Отказ боту («нет / STOP»): то же через API.
    const third = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995533333333' });
    const out = await botCall('POST', '/api/outreach/optout', { phone: '533 33 33 33', reason: 'просил не писать' });
    assert.equal(out.data.status, 'opted_out');
    assert.equal((await call('GET', third.data.confirm_url.replace('https://xtender.ge', ''))).status, 200);
    assert.equal((await botCall('POST', '/api/outreach/optout', { phone: '+995544444444' })).data.status, 'opted_out', 'номер без черновика тоже');

    // Истёкший черновик: анкета стёрта, страница «срок истёк», новый POST — новая ссылка.
    const fourth = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995555555555' });
    await pool.query("UPDATE provider_drafts SET expires_at = $1 WHERE phone = '+995555555555'", [new Date(Date.now() - 1000)]);
    assert.equal((await botCall('GET', '/api/outreach/status?phone=%2B995555555555')).data.status, 'expired');
    const expired = (await pool.query("SELECT * FROM provider_drafts WHERE phone = '+995555555555'")).rows[0];
    assert.deepEqual([expired.status, drafts.json(expired.data, null)], ['expired', {}]);
    assert.ok((await call('GET', fourth.data.confirm_url.replace('https://xtender.ge', ''))).data.includes(require('../src/config/provider-draft-copy').ru.expiredTitle));
    const renewed = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995555555555' });
    assert.equal(renewed.status, 201); assert.notEqual(renewed.data.confirm_url, fourth.data.confirm_url);
    assert.equal((await call('GET', fourth.data.confirm_url.replace('https://xtender.ge', ''))).status, 404);

    // Проба бота: профиль после подтверждения тестовый, в счётчиках не участвует.
    const probe = await botCall('POST', '/api/outreach/drafts', { ...DRAFT, phone: '+995566666666', test: true });
    const tokenP = probe.data.confirm_url.split('/c/')[1];
    const pageP = await call('GET', '/c/' + tokenP);
    const formP = { ...form, _csrf: pageP.data.match(/csrf = "([a-f0-9]{64})"/)[1], leadSmsAccepted: false };
    const sentP = await pageCall(`/c/${tokenP}/code`, formP);
    const doneP = await pageCall(`/c/${tokenP}/confirm`, { _csrf: formP._csrf, code: codes[codes.length - 1].code, challengeId: sentP.data.challengeId });
    assert.equal(doneP.data.leadSms, false);
    const probeMaster = (await pool.query("SELECT is_technical, is_subscribed FROM masters WHERE phone = '+995566666666'")).rows[0];
    assert.deepEqual([probeMaster.is_technical, probeMaster.is_subscribed], [true, false]);

    // Админка: счётчики без проб.
    const admin = await drafts.adminRows({});
    assert.deepEqual([admin.stats.created, admin.stats.confirmed, admin.stats.active, admin.stats.declined, admin.stats.opted_out], [4, 1, 1, 1, 2]);
    assert.deepEqual(admin.sources, ['fb_group_remont']);
    assert.equal((await drafts.adminRows({ status: 'test' })).rows.length, 1);
    require('ejs').compile(fs.readFileSync(path.join(__dirname, '../src/views/admin/outreach-drafts.ejs'), 'utf8'));

    // Перебор ссылок: после 30 неверных за час — 429.
    for (let i = 0; i < 30; i++) await call('GET', '/c/ABCDEFGH');
    assert.equal((await call('GET', '/c/' + token)).status, 429);

    console.log('PASS: bot API (key, services, validation, one draft per phone, 409s, status, changes, opt-out), /c/ page (unticked boxes, masked phone, code from site, registration to moderation, consent snapshot, 60 free days), decline, expiry, test drafts, admin counters, link guessing limit');
  } finally {
    server.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
