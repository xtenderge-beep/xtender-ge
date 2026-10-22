// Тестовое окружение (решение 11 владельца, docs/api-v1/BACKEND_AUDIT.md, разделы 12–13): с XTENDER_SANDBOX=1 настоящая
// SMS уходит только с кодом входа и только на номер из SANDBOX_REAL_SMS_NUMBERS, и этот код в приёмник не попадает;
// любая другая SMS, в том числе рассылка исполнителю на разрешённый номер, остаётся в приёмнике. Приёмник закрыт ключом
// SANDBOX_SINK_KEY. Google Analytics и пиксель Meta в песочнице выключены.
const assert = require('node:assert/strict');

process.env.SMS_GATEWAY_USERNAME = 'test-user';
process.env.SMS_GATEWAY_PASSWORD = 'test-password';
process.env.SANDBOX_REAL_SMS_NUMBERS = '+995544000001, 544000002';
process.env.SANDBOX_SINK_KEY = 'sink-key-123';
const gateway = [];
require.cache[require.resolve('axios')] = { exports: { get: async (url, { params }) => { gateway.push(params); return { data: '0000-api_test' + gateway.length }; } } };

const harness = require('./api-v1-harness');

(async () => {
  const { server, base } = await harness.start();
  const sink = (phone, key = 'sink-key-123') => fetch(base + '/api/v1/sandbox/sms?' + new URLSearchParams({ phone, ...(key ? { key } : {}) }));
  try {
    // 1. Приёмник без ключа и с чужим ключом — как будто его нет.
    assert.equal((await sink('+995544000009', null)).status, 404);
    assert.equal((await sink('+995544000009', 'wrong')).status, 404);

    // 2. Вход на разрешённый номер: код уходит настоящей SMS (шлюз вызван), в приёмнике его нет.
    process.env.SANDBOX_SINK_KEY = 'sink-key-123';
    const sms = require('../src/services/sms.service');
    const otp = require('../src/services/otp.service');
    await harness.resetLimits('+995544000001');
    assert.equal((await otp.sendCode('+995544000001', 'oauth')).success, true);
    assert.equal(gateway.length, 1);
    assert.equal(gateway[0].num, '995544000001');
    assert.match(gateway[0].msg, /^Xtender code: \d{4}\. Enter it on xtender\.ge/);
    assert.deepEqual((await (await sink('+995544000001')).json()).items, []);
    // Номер из списка без «+995» тоже разрешён.
    await harness.resetLimits('+995544000002');
    await otp.sendCode('+995544000002', 'oauth');
    assert.equal(gateway.length, 2);

    // 3. Рассылка исполнителю на разрешённый номер — не код: только в приёмник.
    await sms.sendOrderNotification('+995544000001', 'Xtender: Zakazi (Order) #1: https://example.test/order/x', { kind: 'lead' });
    assert.equal(gateway.length, 2, 'рассылки в тестовом окружении не уходят');
    let items = (await (await sink('+995544000001')).json()).items;
    assert.deepEqual(items.map((item) => item.text), ['Xtender: Zakazi (Order) #1: https://example.test/order/x']);

    // 4. Код на номер не из списка — в приёмник, шлюз не вызван.
    await harness.resetLimits('+995544000009');
    await otp.sendCode('+995544000009', 'oauth');
    assert.equal(gateway.length, 2);
    items = (await (await sink('+995544000009')).json()).items;
    assert.match(items[0].text, /^Xtender code: \d{4}/);

    // 5. Счётчики Google и Meta в песочнице выключены, если не заданы явно.
    const googleTag = require('../src/config/googleTag');
    const metaPixel = require('../src/config/metaPixel');
    assert.equal(googleTag.resolveId({ NODE_ENV: 'production', XTENDER_SANDBOX: '1' }), '');
    assert.equal(metaPixel.resolveId({ NODE_ENV: 'production', XTENDER_SANDBOX: '1' }), '');
    assert.equal(googleTag.resolveId({ NODE_ENV: 'production' }), 'G-RP7E07YTBH', 'на рабочем сайте как раньше');
  } finally {
    server.close();
  }
  process.stdout.write('api v1 sandbox sms tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
