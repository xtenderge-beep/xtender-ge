// Правила сделки на уровне сервисов (docs/api-v1/WORKFLOWS.md, NOTIFICATIONS.md): три способа ответа, истечение срока
// сбора и выбора, выбор другого после отказа, совпавшие события одной SMS, тихие часы, отписка, суточный лимит, сбой SMS
// с повторами и оповещением модератора, неясный ответ шлюза без повтора, восстановление обработчика после падения,
// повтор события без второй SMS, страница /admin/outbox.
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.DEAL_WORKER = 'manual';
const harness = require('./api-v1-harness');

const { pool, redis } = harness;
// Telegram: записываем оповещения модератору (остальные вызовы — ничего не делают).
const alerts = [];
require.cache[require.resolve('../src/services/telegram.service')].exports = new Proxy({}, {
  get: (target, name) => (name === 'sendMessageToModerator' ? async (text) => { alerts.push(text); } : async () => null),
});
const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const tenders = require('../src/services/tender.service');
const offers = require('../src/services/offer.service');
const selections = require('../src/services/selection.service');
const notify = require('../src/services/dealNotify.service');
const outbox = require('../src/services/outbox.service');
const worker = require('../src/services/dealWorker.service');
const accounts = require('../src/services/account.service');
const smsService = require('../src/services/sms.service');
const sinkFor = async (phone) => (await redis.lrange('sandbox:sms', 0, -1)).map((line) => JSON.parse(line)).filter((m) => m.to === phone);

let phones = 0;
async function newDeal({ mode, sms = true, startInDays = 3, quiet = null } = {}) {
  phones += 1;
  const phone = '+99559977' + String(1000 + phones);
  let account = await accounts.ensureForVerifiedPhone(phone);
  if (quiet) await pool.query('UPDATE accounts SET quiet_from=$2, quiet_to=$3 WHERE id=$1', [account.id, quiet[0], quiet[1]]);
  const draft = await tenders.createDraft(account, { title: 'Job ' + phones, description: 'Details', language: 'en', category_ids: ['movers'], location: { city_id: 'city:tbilisi' },
    requested_start_at: new Date(Date.now() + startInDays * day).toISOString(), ...(mode ? { response_mode: mode } : {}) });
  try { await tenders.publish(account, tenders.apiId(draft), draft.api_version); } catch (error) {
    const bundle = await require('../src/services/consent.service').bundle('client', 'en');
    await require('../src/services/accountConsent.service').accept(error.details.consent_url.split('/').pop(), { bundle, sms });
  }
  account = await accounts.getById(account.id);
  const fresh = (await pool.query('SELECT * FROM orders WHERE id=$1', [draft.id])).rows[0];
  await tenders.publish(account, tenders.apiId(fresh), fresh.api_version);
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [draft.id])).rows[0];
  const dispatch = require('../src/services/dispatch.service');
  const plan = await dispatch.preview(order.token, 'movers', '');
  await dispatch.dispatch(order.token, 'movers', '', { price: plan.price, count: plan.count, revision: 0 });
  return { phone, account, order: (await pool.query('SELECT * FROM orders WHERE id=$1', [draft.id])).rows[0] };
}
const reload = async (order) => (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
const offerBody = (price) => ({ line_items: [{ offered_name: 'Work', line_total_minor: price }] });
async function submitOffer(master, order, price = 10000) {
  const draft = await offers.createDraft(master, tenders.apiId(order), offerBody(price));
  return offers.submit(master, draft.id, draft.version);
}
const tbilisiTime = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

(async () => {
  const { server, base } = await harness.start();
  try {
    const p1 = await harness.addMaster({ phone: '+995599888001', name: 'One' });
    const p2 = await harness.addMaster({ phone: '+995599888002', name: 'Two' });
    const contact = require('../src/services/orderContact.service');

    // 1. Три способа ответа. Звонки — как раньше: предложений нет, телефон по рассылке открыт.
    const calls = await newDeal({ mode: 'calls' });
    await assert.rejects(offers.createDraft(p1, tenders.apiId(calls.order), offerBody(1)), (e) => e.code === 'OFFERS_NOT_ACCEPTED');
    assert.equal((await contact.reveal(calls.order.token, p1.master_token, 'call')).status, 200);
    assert.equal(calls.order.submission_deadline !== null, true);
    // «Оба»: и предложение, и звонок до выбора.
    const both = await newDeal({ mode: 'both' });
    assert.equal((await submitOffer(p1, both.order)).status, 'submitted');
    assert.equal((await contact.reveal(both.order.token, p1.master_token, 'call')).status, 200);
    // «Сначала предложения»: звонок закрыт; расширение до «оба» открывает его, сузить обратно нельзя.
    const offersOnly = await newDeal({});
    assert.equal((await contact.reveal(offersOnly.order.token, p1.master_token, 'call')).code, 'offers_only');
    await tenders.setResponseMode(offersOnly.order.id, 'both');
    assert.equal((await contact.reveal(offersOnly.order.token, p1.master_token, 'call')).status, 200);
    await assert.rejects(tenders.setResponseMode(offersOnly.order.id, 'offers'), (e) => e.code === 'ACTION_NOT_ALLOWED');
    assert.match((await reload(offersOnly.order)).description, /call or written offer/);

    // 2. Срок сбора: первое предложение — SMS; по сроку обработчик закрывает сбор — вторая SMS с числом; позже — отказ.
    const timed = await newDeal({});
    await submitOffer(p1, timed.order);
    await worker.runOnce(new Date());
    const deadline = new Date((await reload(timed.order)).submission_deadline);
    assert.ok(deadline - Date.now() <= 24 * hour + 60000 && deadline - Date.now() > 23 * hour);
    await worker.runOnce(new Date(deadline.getTime() + 60000));
    const timedSms = (await sinkFor(timed.phone)).map((m) => m.text);
    assert.equal(timedSms.filter((t) => /first offer/.test(t)).length, 1);
    assert.equal(timedSms.filter((t) => /closed for offers, 1 received/.test(t)).length, 1);
    await assert.rejects(submitOffer(p2, await reload(timed.order)), (e) => e.code === 'COLLECTION_CLOSED');
    // Повтор прохода — без новых SMS (события и уведомления с ключом).
    await worker.runOnce(new Date(deadline.getTime() + 120000));
    assert.equal((await sinkFor(timed.phone)).length, timedSms.length);
    // Срок сбора не позже чем за 2 часа до начала работ.
    const soon = await newDeal({ startInDays: 0.5 });
    const soonOrder = await reload(soon.order);
    assert.ok(new Date(soonOrder.submission_deadline) <= new Date(soonOrder.requested_start_at).getTime() - 2 * hour + 1000);

    // 3. Тихие часы и совпавшие события: SMS о первом предложении ждёт утра; если до утра закрылся сбор — одна SMS.
    const now = new Date();
    const quiet = await newDeal({ quiet: [tbilisiTime(new Date(now - hour)), tbilisiTime(new Date(now.getTime() + 2 * hour))] });
    await submitOffer(p1, quiet.order);
    await worker.runOnce(new Date());
    assert.equal((await sinkFor(quiet.phone)).filter((m) => /offer/.test(m.text)).length, 0, 'no SMS in quiet hours');
    const quietOrder = await reload(quiet.order);
    await tenders.closeCollection(quietOrder.id, { actor: 'customer', expected: quietOrder.api_version });
    await worker.runOnce(new Date());
    await worker.runOnce(new Date(now.getTime() + 3 * hour));
    const quietSms = (await sinkFor(quiet.phone)).filter((m) => /offer/.test(m.text)).map((m) => m.text);
    assert.deepEqual(quietSms.length, 1, JSON.stringify(quietSms));
    assert.match(quietSms[0], /closed for offers, 1 received/);
    assert.ok((await notify.forOrder(quiet.order.id, 'customer')).some((d) => d.rule === 'first_offer' && d.error_code === 'merged'), JSON.stringify(await notify.forOrder(quiet.order.id)));

    // 4. Выбор, истечение подтверждения, выбор другого после отказа.
    const sel = await newDeal({});
    const o1 = await submitOffer(p1, sel.order, 9000);
    const o2 = await submitOffer(p2, sel.order, 9500);
    let live = await reload(sel.order);
    const first = await selections.select(live.id, { offerId: o1.id, offerVersion: o1.version, tenderVersion: live.api_version });
    assert.ok(new Date(first.confirm_by) - Date.now() <= 24 * hour + 60000);
    await worker.runOnce(new Date(new Date(first.confirm_by).getTime() + 60000));
    assert.equal((await selections.latest(live.id)).status, 'expired');
    assert.equal((await offers.mine(live.id, p1.id)).status, 'expired');
    live = await reload(sel.order);
    assert.equal(tenders.status(live), 'closed', 'back to choosing another offer');
    await assert.rejects(selections.accept(p1, o1.id), (e) => e.status === 404 || e.code === 'ACTION_NOT_ALLOWED');
    const o2now = await offers.mine(live.id, p2.id);
    await selections.select(live.id, { offerId: o2.id, offerVersion: o2now.version, tenderVersion: live.api_version });
    await selections.decline(p2, o2.id, 'Truck broke down');
    live = await reload(sel.order);
    assert.equal(tenders.status(live), 'closed');
    assert.equal((await offers.listForOrder(live.id)).length, 0, 'no active offers left');
    // Отказ без причины не принимается; чужой выбор не подтвердить.
    const sel2 = await newDeal({});
    const a = await submitOffer(p1, sel2.order);
    const liveSel2 = await reload(sel2.order);
    await selections.select(liveSel2.id, { offerId: a.id, offerVersion: a.version, tenderVersion: liveSel2.api_version });
    await assert.rejects(selections.decline(p1, a.id, ''), (e) => e.code === 'VALIDATION_FAILED');
    await assert.rejects(selections.accept(p2, a.id), (e) => e.status === 404);
    // Отмена до подтверждения снимает выбор; предложения — «не выбрано».
    await tenders.cancel(liveSel2.id, { reason: 'Plans changed' });
    assert.equal((await selections.latest(liveSel2.id)).status, 'cancelled');
    assert.equal((await reload(sel2.order)).status, 'closed');

    // 5. Отписка снимает уже поставленные SMS; суточный лимит.
    const opt = await newDeal({ quiet: [tbilisiTime(new Date(now - hour)), tbilisiTime(new Date(now.getTime() + 2 * hour))] });
    await submitOffer(p1, opt.order);
    await worker.runOnce(new Date());
    await notify.setSettings(await reload(opt.order), { smsEnabled: false });
    assert.ok((await notify.forOrder(opt.order.id, 'customer')).every((d) => d.status === 'cancelled'));
    const capped = await newDeal({});
    for (let i = 0; i < notify.DAILY_SMS_LIMIT; i += 1) {
      await pool.query("INSERT INTO notification_deliveries (order_id, recipient_role, recipient_ref, channel, rule, dedupe_key, body, status, sent_at) VALUES ($1,'customer',$2,'sms','first_offer',$3,'x','sent',NOW())",
        [capped.order.id, 'order:' + capped.order.id, 'cap-' + i]);
    }
    await submitOffer(p1, capped.order);
    await worker.runOnce(new Date());
    assert.ok((await notify.forOrder(capped.order.id, 'customer')).some((d) => d.error_code === 'daily_limit'));

    // 6. Сбой шлюза: известный отказ — повторы с паузой, после 4 попыток «ошибка» и оповещение модератора;
    // неясный ответ — «неизвестно», без повтора.
    const original = smsService.sendOrderNotification;
    smsService.sendOrderNotification = async () => { throw Object.assign(new Error('gateway rejected'), { deliveryUnknown: false }); };
    const failing = await newDeal({});
    await submitOffer(p1, failing.order);
    let at = new Date();
    for (let i = 0; i < 6; i += 1) { await worker.runOnce(at); at = new Date(at.getTime() + 20 * 60 * 1000); }
    const failed = (await notify.forOrder(failing.order.id, 'customer')).find((d) => d.rule === 'first_offer');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 4);
    assert.ok(alerts.some((text) => text.includes('#' + failing.order.id) && text.includes('/admin/outbox')));
    smsService.sendOrderNotification = async () => { throw Object.assign(new Error('timeout'), { deliveryUnknown: true }); };
    const unclear = await newDeal({});
    await submitOffer(p1, unclear.order);
    await worker.runOnce(new Date());
    await worker.runOnce(new Date(Date.now() + hour));
    const unknown = (await notify.forOrder(unclear.order.id, 'customer')).find((d) => d.rule === 'first_offer');
    assert.deepEqual([unknown.status, unknown.attempts], ['unknown', 1], 'an unclear answer is not retried');
    smsService.sendOrderNotification = original;

    // 7. Восстановление: обработчик взял событие и упал — блокировка истекает, событие обрабатывается один раз.
    const crash = await newDeal({});
    await submitOffer(p1, crash.order);
    const taken = await outbox.claim(50, new Date());
    assert.ok(taken.length >= 1);
    await worker.runOnce(new Date());
    assert.equal((await notify.forOrder(crash.order.id, 'customer')).length, 0, 'locked events wait');
    await worker.runOnce(new Date(Date.now() + outbox.LOCK_MS + 1000));
    assert.equal((await notify.forOrder(crash.order.id, 'customer')).filter((d) => d.rule === 'first_offer').length, 1);
    // Повтор того же события обработчиком — без второго уведомления; повтор emit с тем же ключом — одна строка.
    const event = (await pool.query("SELECT * FROM outbox_events WHERE order_id=$1 AND event_type='offer.submitted'", [crash.order.id])).rows[0];
    await notify.handle(event);
    assert.equal((await notify.forOrder(crash.order.id, 'customer')).filter((d) => d.rule === 'first_offer').length, 1);
    await pool.withTransaction((client) => outbox.emit(client, 'offer.submitted', crash.order.id, event.payload, event.dedupe_key));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM outbox_events WHERE dedupe_key=$1', [event.dedupe_key])).rows[0].n, 1);
    // Сломанный обработчик: после 6 попыток событие «не обработано», модератор оповещён, повтор из админки ставит его в очередь.
    await pool.withTransaction((client) => outbox.emit(client, 'selection.created', crash.order.id, { selection_id: null }, 'broken-1'));
    const handle = notify.handle;
    notify.handle = async () => { throw new Error('boom'); };
    require.cache[require.resolve('../src/services/dealNotify.service')].exports.handle = notify.handle;
    at = new Date();
    for (let i = 0; i < 7; i += 1) { await worker.runOnce(at); at = new Date(at.getTime() + 2 * hour); }
    notify.handle = handle;
    const broken = (await pool.query("SELECT * FROM outbox_events WHERE dedupe_key='broken-1'")).rows[0];
    assert.ok(broken.failed_at, JSON.stringify(broken));
    assert.ok(alerts.some((text) => text.includes('selection.created')));

    // 8. /admin/outbox показывает сбои.
    const ejs = require('ejs');
    const req = { query: {} };
    let rendered = null;
    await require('../src/controllers/dealAdmin.controller').index(req, { render: (view, data) => { rendered = { view, data }; } });
    const html = await ejs.renderFile(path.join(__dirname, '../src/views', rendered.view + '.ejs'), { ...rendered.data, csrfToken: 'x', navCounts: {} });
    assert.ok(html.includes('selection.created') && html.includes('Повторить'));
    assert.ok(html.includes('Неизвестно') && html.includes('Ошибка'));
    assert.ok(await outbox.retry(broken.id));
    assert.equal((await pool.query("SELECT failed_at FROM outbox_events WHERE dedupe_key='broken-1'")).rows[0].failed_at, null);

    // 9. Засев тестового окружения: только в песочнице и только с SANDBOX_SEED=1, без дублей при повторном старте.
    const seed = require('../src/services/sandboxSeed.service');
    delete process.env.SANDBOX_SEED;
    assert.equal(await seed.run(), 0);
    process.env.SANDBOX_SEED = '1';
    process.env.XTENDER_SANDBOX = '';
    assert.equal(await seed.run(), 0, 'never on the live site');
    process.env.XTENDER_SANDBOX = '1';
    assert.equal(await seed.run(), require('../src/config/sandboxData').SANDBOX.providers.length);
    assert.equal(await seed.run(), 0);
    delete process.env.SANDBOX_SEED;

    process.stdout.write('deal rules tests passed\n');
  } finally {
    server.close();
  }
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
