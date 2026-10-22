// Песочница API целиком (scripts/api-sandbox.js — настоящий src/app.js на pg-mem): маршруты OAuth и /api/v1
// подключены в app.js и не мешают сайту, неверный JSON к /api/v1 отвечает форматом API, вход по номеру и коду
// из SMS-приёмника выдаёт токен, тестовые заказчик и исполнители на месте, SMS никуда не уходят.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { obtainToken } = require('../scripts/api-sandbox-token');

const PORT = String(31000 + Math.floor(Math.random() * 3000));
const base = 'http://127.0.0.1:' + PORT;

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/api-sandbox.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sandbox did not start:\n' + output)), 60000);
      const check = setInterval(() => { if (output.includes('Xtender server running')) { clearTimeout(timer); clearInterval(check); resolve(); } }, 100);
      child.on('exit', (code) => { clearTimeout(timer); clearInterval(check); reject(new Error('sandbox exited ' + code + ':\n' + output)); });
    });

    // Сайт по-прежнему отвечает, OAuth и API подключены рядом.
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/health')).headers.get('x-robots-tag'), 'noindex, nofollow', 'песочница закрыта от поиска');
    const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(meta.issuer, base);
    const caps = await fetch(base + '/api/v1/capabilities');
    assert.equal(caps.headers.get('x-xtender-environment'), 'sandbox');
    assert.equal((await caps.json()).environment, 'sandbox');
    const old = await fetch(base + '/api/masters');
    assert.equal(old.status, 200, 'прежний /api работает');
    const bad = await fetch(base + '/api/v1/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{oops' });
    const badBody = await bad.json();
    assert.deepEqual([bad.status, badBody.error.code], [400, 'INVALID_JSON']);
    assert.ok(badBody.request_id && bad.headers.get('x-request-id') === badBody.request_id);
    assert.equal((await fetch(base + '/api/v1/unknown')).status, 404);

    // Вход заказчика и исполнителя песочницы.
    const customer = await obtainToken({ base, phone: '+995500000001' });
    const me = await (await fetch(base + '/api/v1/me', { headers: { authorization: 'Bearer ' + customer.access_token } })).json();
    assert.deepEqual([me.roles, me.environment], [['customer'], 'sandbox']);
    const provider = await obtainToken({ base, phone: '+995500000003' });
    const profile = await (await fetch(base + '/api/v1/me/provider-profile', { headers: { authorization: 'Bearer ' + provider.access_token } })).json();
    assert.deepEqual([profile.category_ids, profile.status], [['van'], 'active']);
    const categories = await (await fetch(base + '/api/v1/categories?q=movers&location_id=city:tbilisi')).json();
    assert.deepEqual([categories.items[0].id, categories.items[0].supply_status.provider_count], ['movers', 1]);
    assert.match(output, /\[SMS SANDBOX\]/);
    assert.doesNotMatch(output, /\[SMS GATEWAY\]/, 'шлюз не вызывался');
  } finally {
    child.kill();
  }
  process.stdout.write('api v1 sandbox tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
