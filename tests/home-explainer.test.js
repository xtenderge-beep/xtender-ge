// Анимация «как работает заявка» на главной (partials/home-explainer.ejs + public/js/home-explainer.js).
// Проверяет то, что ломается незаметно: сырые ключи на одном из языков, событие позже конца
// ролика (оно никогда не наступит), обещание цены в шагах и место блока на странице.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { translate, clientStrings } = require('../src/config/i18n');

const root = path.join(__dirname, '..');
const partial = path.join(root, 'src/views/partials/home-explainer.ejs');
const script = fs.readFileSync(path.join(root, 'public/js/home-explainer.js'), 'utf8');
const END = Number(script.match(/var END = ([\d.]+);/)[1]);
const STEPS = script.match(/var STEPS = \[([^\]]+)\]/)[1].split(',').map(Number);

(async () => {
  for (const lang of ['ka', 'ru', 'en']) {
    const t = translate(lang);
    const html = await ejs.renderFile(partial, { t, lang });
    assert.doesNotMatch(html, /explainer_[a-z0-9_]+/, `${lang}: a key printed as text`);
    for (const n of [1, 2, 3, 4]) assert.ok(html.includes(t('explainer_step' + n)), `${lang}: step ${n} is readable text`);
    assert.ok(html.includes(t('explainer_request')), `${lang}: the example request is in the page`);
    // Collapsed by default: the first screen carries only the offer, details open on demand.
    assert.match(html, /<button type="button" class="hx-toggle" id="hxToggle" aria-expanded="false" aria-controls="hxPanel"/, `${lang}: toggle starts collapsed`);
    assert.match(html, /<div class="hx-panel" id="hxPanel"[^>]*\shidden>/, `${lang}: panel starts hidden`);
    assert.ok(html.includes(`data-label-open="${t('home_nav_how')}"`) && html.includes(`data-label-close="${t('explainer_collapse')}"`), `${lang}: both toggle labels translated`);
    assert.ok(html.indexOf('class="hx-defs"') < html.indexOf('id="hxPanel"'), `${lang}: icon symbols live outside the hidden panel`);
    assert.equal((html.match(/class="hx-bust"/g) || []).length, 7, `${lang}: seven providers receive the request`);
    assert.equal((html.match(/class="hx-fly"/g) || []).length, 7, `${lang}: one flying copy per provider`);
    assert.equal((html.match(/class="hx-offer"/g) || []).length, 3, `${lang}: three responses`);
    assert.match(html, /class="hx-cta" href="#post-section"/, `${lang}: the phone layout leads back to the form`);
    assert.match(html, /<div class="hx-canvas" aria-hidden="true">/, `${lang}: the drawing is hidden from screen readers`);
    assert.doesNotMatch(html, /class="hx-vis"[^>]*aria-hidden/, `${lang}: the closing line and buttons stay readable`);

    // Every timed event must happen before the end, otherwise the final frame never shows it.
    const times = [
      ...[...html.matchAll(/data-(?:at|off|until|type-at)="([\d.]+)"/g)].map(m => Number(m[1])),
      ...[...html.matchAll(/data-states="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/).map(pair => Number(pair.split(':')[0]))),
    ];
    assert.ok(times.length > 30, `${lang}: timed elements found`);
    assert.ok(Math.max(...times) < END, `${lang}: an event at ${Math.max(...times)}s is after the end (${END}s)`);
  }

  assert.deepEqual(STEPS, [...STEPS].sort((a, b) => a - b), 'steps are in order');
  assert.ok(STEPS[STEPS.length - 1] < END, 'the last step starts before the end');

  // Step 3 shows prices as an example only; the words do not promise a price (copy-and-cognitive-load.md, rule 4).
  assert.doesNotMatch(clientStrings('ru').explainer_step3, /цен/i);
  assert.doesNotMatch(clientStrings('en').explainer_step3, /price|quote/i);
  assert.doesNotMatch(clientStrings('ka').explainer_step3, /ფას/);

  // Placement: beside the form on desktop, under it on phones (#seo-hero is the "intro" grid area).
  const index = fs.readFileSync(path.join(root, 'src/views/index.ejs'), 'utf8');
  const intro = index.slice(index.indexOf('<div id="seo-hero"'), index.indexOf('<section id="tender-live-section"'));
  assert.match(intro, /include\('partials\/home-explainer'\)/, 'the explainer sits in the hero intro');
  assert.doesNotMatch(index, /home-points/, 'the old three points are gone');
  const head = index.slice(index.indexOf('<div class="home-hero-head">'), index.indexOf('<section id="post-section"'));
  assert.match(head, /t\('home_hero_lead_short'\)/, 'one short offer line on every screen');
  assert.doesNotMatch(head, /t\('home_hero_lead'\)/, 'the long lead is not shown');
  for (const lang of ['ka', 'ru', 'en']) assert.match(clientStrings(lang).home_hero_lead_short, /./, `${lang}: short lead exists`);
  const css = fs.readFileSync(path.join(root, 'src/styles/input.css'), 'utf8');
  assert.doesNotMatch(css, /\.home-page \.home-free-note \{ display:none; \}/, 'without the points, the free note beside the form is shown again');

  console.log('PASS: homepage explainer renders in ka/ru/en, every event fits the timeline, no price promise, placed in the hero intro.');
})().catch(error => { console.error(error); process.exitCode = 1; });
