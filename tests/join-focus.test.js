// Registration page modes. A visitor who arrives by a manager's referral link or by a promo link already knows
// why they came, so the page is the registration form and nothing else. Organic visitors keep the full page.
// The legal part (short facts and both consent checkboxes) is part of the form and must survive in every mode.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

process.env.NODE_ENV = 'development';
const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => { const backup = db.backup(); try { return await fn(pool); } catch (e) { backup.restore(); throw e; } };
require.cache[require.resolve('../src/config/db')] = { exports: pool };
const Redis = require('ioredis-mock');
const redis = new Redis();
require.cache[require.resolve('../src/config/redis')] = { exports: redis };

const partners = require('../src/services/partner.service');
const managers = require('../src/services/manager.service');
const promos = require('../src/services/promo.service');
const settings = require('../src/services/settings.service');

(async () => {
  const manager = await managers.create({ name: 'Alice', phone: '+995500001001' });
  const token = await partners.createLink(manager.id);
  await settings.setWelcomeBonusTetri(500);
  await promos.createCode({ code: 'FRIEND5', amountTetri: 500 });

  const express = require('express');
  const app = express();
  app.set('views', path.join(__dirname, '../src/views'));
  app.set('view engine', 'ejs');
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use((req, res, next) => { req.lang = 'ru'; res.locals.currentPath = req.path; next(); });
  app.use('/:locale(ru|en)', require('../src/routes/public.routes'));
  app.use('/', require('../src/routes/public.routes'));
  app.use((err, req, res, next) => { console.error(err); res.status(500).send('test failure'); });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  async function page(url, cookie) {
    const response = await fetch(base + url, { headers: cookie ? { cookie } : {} });
    return { status: response.status, html: await response.text(), setCookie: response.headers.get('set-cookie') || '' };
  }
  const count = (html, text) => html.split(text).length - 1;
  // The page embeds the whole dictionary for its script, so visible text is checked on the heading element.
  const heading = html => ((html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [])[1] || '').trim();
  const noise = ['provider-illustration', 'provider-pricing', 'provider-guide', 'provider-welcome'];
  // What must stay, in every mode: the form, the four short facts and both consent checkboxes.
  const form = ['id="signupCard"', 'id="descriptionInput"', 'signupBeforeTitle', 'id="termsCheckbox"', 'id="privacyCheckbox"', 'id="sendOtpButton"'];

  try {
    // Organic visitor: the full page, the pitch and the bonus.
    const organic = await page('/ru/join');
    assert.equal(organic.status, 200);
    assert.ok(!organic.html.includes('provider-join-focused'));
    for (const marker of [...noise, ...form]) assert.ok(organic.html.includes(marker), 'organic page must contain ' + marker);
    assert.equal(heading(organic.html), 'Находите новых клиентов');

    // Manager's referral link: the registration form only.
    const referred = await page('/ru/join?ref=' + token);
    assert.equal(referred.status, 200);
    assert.ok(referred.html.includes('provider-join-focused'));
    for (const marker of noise) assert.ok(!referred.html.includes(marker), 'focused page must not contain ' + marker);
    for (const marker of form) assert.ok(referred.html.includes(marker), 'focused page must keep ' + marker);
    assert.equal(heading(referred.html), 'Регистрация исполнителя');
    assert.ok(referred.html.includes('<p class="text-sm text-stone-500 mt-2">Уже есть профиль?'));
    assert.ok(referred.setCookie.includes('partner_ref=' + token), 'attribution cookie is still set');
    // The language switcher points at clean URLs, so it must carry the parameters.
    assert.ok(referred.html.includes('/en/join?ref=' + token + '"'));
    assert.ok(referred.html.includes('/join?lang=ka&amp;ref=' + token + '"'));
    assert.ok(referred.html.includes('/ru/join?ref=' + token + '"'));
    // Search engines must keep seeing clean URLs in canonical and alternate links.
    const links = referred.html.match(/<link [^>]*>/g) || [];
    assert.ok(links.length > 0 && links.every(link => !link.includes('?ref=') && !link.includes('&amp;ref=')), 'no tracking parameter in head links');

    // A later visit without the parameter: the cookie keeps the mode, and no second cookie is written.
    const returning = await page('/ru/join', 'partner_ref=' + token);
    assert.ok(returning.html.includes('provider-join-focused'));
    assert.ok(!returning.setCookie.includes('partner_ref='));

    // An unknown or malformed referral is not a referral: full page, no cookie.
    for (const url of ['/ru/join?ref=bad', '/ru/join?ref=' + 'a'.repeat(36)]) {
      const unknown = await page(url);
      assert.equal(unknown.status, 200);
      assert.ok(!unknown.html.includes('provider-join-focused'), url);
      assert.ok(!unknown.setCookie.includes('partner_ref='));
    }

    // A valid promo link: focused, one line with the verified amount at the top, no duplicate in step three.
    const promo = await page('/ru/join?promo=friend5');
    assert.ok(promo.html.includes('provider-join-focused') && promo.html.includes('provider-focus-promo is-valid'));
    assert.equal(count(promo.html, 'Промокод FRIEND5 — 5.00 ₾ на баланс при регистрации'), 1);
    assert.ok(!promo.html.includes('provider-welcome'), 'the general bonus block is gone');
    assert.ok(promo.html.includes('value="FRIEND5"'), 'the code still travels with the form');
    assert.ok(promo.html.includes('/en/join?promo=FRIEND5"'), 'the promo survives a language change');
    assert.ok(promo.html.includes('/join?lang=ka&amp;promo=FRIEND5"'));

    // An invalid promo is reported at the top too, once.
    const bad = await page('/ru/join?promo=NOPE');
    assert.ok(bad.html.includes('provider-join-focused') && bad.html.includes('provider-focus-promo is-invalid'));
    assert.equal(count(bad.html, 'Промокод NOPE недействителен или исчерпан'), 1);

    // A repeated parameter must not crash the page; it is not a promo.
    const repeated = await page('/ru/join?promo=a&promo=b');
    assert.equal(repeated.status, 200);
    assert.ok(!repeated.html.includes('provider-join-focused'));

    // The other languages render the same way.
    const english = await page('/en/join?ref=' + token);
    assert.ok(english.html.includes('provider-join-focused') && english.html.includes('Provider Registration') && english.html.includes('Already have a profile?'));
    const georgian = await page('/join?ref=' + token + '&lang=ka');
    assert.ok(georgian.html.includes('provider-join-focused') && georgian.html.includes('შემსრულებლის რეგისტრაცია') && georgian.html.includes('უკვე გაქვთ პროფილი?'));
    for (const marker of form) assert.ok(english.html.includes(marker) && georgian.html.includes(marker));
  } finally {
    server.close();
    redis.disconnect();
  }
  console.log('PASS: full page for organic visitors, registration-only page for referral and promo links, legal part kept, parameters survive a language change, clean head links.');
})().catch(error => { console.error(error); process.exitCode = 1; });
