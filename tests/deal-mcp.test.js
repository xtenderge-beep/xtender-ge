// Сделка через инструменты MCP (так её ведёт ChatGPT): каталог без входа, черновик → проверка → согласие → публикация →
// рассылка модератором → вопрос и предложение исполнителя → данные сравнения → выбор → подтверждение. Плюс: без входа
// инструмент сделки просит подключить аккаунт, без нужной области — тоже, аккаунт «только чтение» ничего не меняет,
// ошибки правил приходят кодом (CONSENT_REQUIRED, VERSION_MISMATCH), а не сбоем.
const assert = require('node:assert/strict');
process.env.DEAL_WORKER = 'manual';
const harness = require('./api-v1-harness');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const SCOPES = 'profile:read profile:write tenders:read tenders:write offers:read offers:write messages:read messages:write notifications:write';
const day = 24 * 60 * 60 * 1000;

(async () => {
  const { server, base } = await harness.start();
  const connect = async (token) => {
    const client = new Client({ name: 'chatgpt-like', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), token ? { requestInit: { headers: { authorization: 'Bearer ' + token } } } : {}));
    return client;
  };
  const tool = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  };
  const ok = async (client, name, args) => {
    const result = await tool(client, name, args);
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  try {
    const customerPhone = '+995599333001';
    const provider = await harness.addMaster({ phone: '+995599444001', name: 'Levan Movers' });

    // Каталог без входа: категория и город для черновика.
    const anonymous = await connect();
    const found = await ok(anonymous, 'search_categories', { q: 'movers to carry a sofa', lang: 'en' });
    assert.ok(found.items.some((c) => c.id === 'movers'));
    const schema = await ok(anonymous, 'get_category_schema', { category_id: 'movers' });
    assert.ok(schema.json_schema.properties.workers, 'request parameters of the category');
    assert.ok((await ok(anonymous, 'list_locations', { q: 'tbilisi' })).items.some((l) => l.id === 'city:tbilisi'));
    // Инструмент сделки без входа — просьба подключить аккаунт.
    const asked = await tool(anonymous, 'create_tender_draft', { title: 'x' });
    assert.equal(asked.isError, true);
    assert.match(asked._meta['mcp/www_authenticate'][0], /error="insufficient_scope"/);
    await anonymous.close();

    // Токен только на профиль — инструмент заявки просит область tenders:write.
    const narrow = await connect((await harness.login(base, customerPhone, 'profile:read')).access_token);
    const scoped = await tool(narrow, 'create_tender_draft', { title: 'x' });
    assert.match(scoped._meta['mcp/www_authenticate'][0], /The tenders:write scope is required/);
    await narrow.close();

    const customer = await connect((await harness.login(base, customerPhone, SCOPES)).access_token);
    const chosen = await connect((await harness.login(base, provider.phone, SCOPES)).access_token);

    // Черновик, проверка, публикация.
    const start = new Date(Date.now() + 4 * day).toISOString();
    const draft = await ok(customer, 'create_tender_draft', { title: 'Carry a sofa to the 5th floor', description: 'No lift. Sofa 2 m.', language: 'en',
      category_ids: ['movers'], location: { city_id: 'city:tbilisi', public_area_label: 'Vake', private_address: 'Chavchavadze 1' }, requested_start_at: start,
      attributes: { movers: { workers: 2, floor: 5 } } });
    assert.equal(draft.response_mode, 'offers');
    assert.equal((await ok(customer, 'validate_tender', { tender_id: draft.id })).ready_to_publish, true);
    const stale = await tool(customer, 'publish_tender', { tender_id: draft.id, version: draft.version + 5, confirmed_by_user: true });
    assert.equal(stale.isError, true);
    const needConsent = await tool(customer, 'publish_tender', { tender_id: draft.id, version: draft.version, confirmed_by_user: true });
    assert.equal(needConsent.structuredContent.error.code, 'CONSENT_REQUIRED');
    const consentToken = needConsent.structuredContent.error.consent_url.split('/').pop();
    await require('../src/services/accountConsent.service').accept(consentToken, { bundle: await require('../src/services/consent.service').bundle('client', 'en'), sms: false });
    const published = await ok(customer, 'publish_tender', { tender_id: draft.id, version: draft.version, confirmed_by_user: true });
    assert.equal(published.publication_status, 'in_review');

    // Модератор рассылает.
    const orderId = Number(draft.id.slice(4));
    const token = (await harness.pool.query('SELECT token FROM orders WHERE id=$1', [orderId])).rows[0].token;
    const dispatch = require('../src/services/dispatch.service');
    const plan = await dispatch.preview(token, 'movers', '');
    await dispatch.dispatch(token, 'movers', '', { price: plan.price, count: plan.count, revision: 0 });

    // Исполнитель: заявка, вопрос, предложение.
    const opps = await ok(chosen, 'search_opportunities', {});
    assert.deepEqual(opps.items.map((t) => t.id), [draft.id]);
    const message = await ok(chosen, 'send_message', { tender_id: draft.id, text: 'Does the sofa fit in the stairwell?' });
    assert.equal(message.author_role, 'provider');
    const offerDraft = await ok(chosen, 'create_offer_draft', { tender_id: draft.id, line_items: [{ offered_name: 'Two movers', line_total_minor: 9000 }], start_at: start });
    const offer = await ok(chosen, 'submit_offer', { offer_id: offerDraft.id, version: offerDraft.version });
    assert.equal(offer.status, 'submitted');
    // Заказчику предложение нельзя отправить от своего имени: у него нет роли исполнителя.
    const notProvider = await tool(customer, 'create_offer_draft', { tender_id: draft.id, line_items: [{ offered_name: 'x', line_total_minor: 1 }] });
    assert.equal(notProvider.structuredContent.error.code, 'PROVIDER_ROLE_REQUIRED');

    // Заказчик: переписка, сравнение, выбор.
    const threads = await ok(customer, 'list_threads', { tender_id: draft.id });
    assert.equal(threads.items.length, 1);
    await ok(customer, 'send_message', { thread_id: threads.items[0].id, text: 'Yes, it fits.' });
    const comparison = await ok(customer, 'get_comparison_data', { tender_id: draft.id });
    assert.equal(comparison.offers.length, 1);
    assert.equal(comparison.offers[0].offer.total_amount_minor, 9000);
    const noConfirm = await tool(customer, 'select_offer', { tender_id: draft.id, offer_id: offer.id, expected_offer_version: offer.version, expected_tender_version: comparison.tender_version, confirmed_by_user: false });
    assert.equal(noConfirm.structuredContent.error.code, 'CONFIRMATION_REQUIRED');
    const selection = await ok(customer, 'select_offer', { tender_id: draft.id, offer_id: offer.id, expected_offer_version: offer.version, expected_tender_version: comparison.tender_version, confirmed_by_user: true });
    assert.equal(selection.status, 'pending');
    // Повтор того же выбора (ChatGPT повторил вызов) — тот же выбор, не ошибка.
    assert.equal((await ok(customer, 'select_offer', { tender_id: draft.id, offer_id: offer.id, expected_offer_version: offer.version, expected_tender_version: comparison.tender_version, confirmed_by_user: true })).id, selection.id);

    // Подтверждение исполнителем: контакты открыты обоим.
    assert.equal((await ok(chosen, 'accept_selection', { offer_id: offer.id })).status, 'accepted');
    const awarded = await ok(customer, 'get_tender', { tender_id: draft.id });
    assert.equal(awarded.status, 'awarded');
    assert.equal(awarded.provider_contact.phone, provider.phone);
    assert.equal((await ok(chosen, 'get_tender', { tender_id: draft.id })).customer_contact.phone, customerPhone);
    // Новый чат: найти заявку по номеру и получить ссылку возврата.
    assert.equal((await ok(customer, 'resolve_tender', { number: String(orderId) })).id, draft.id);
    assert.match((await ok(customer, 'get_resume_link', { tender_id: draft.id })).url, /\/t\//);

    // Аккаунт «только чтение»: читать можно, менять — нет.
    const accountId = (await harness.pool.query('SELECT id FROM accounts WHERE phone=$1', [customerPhone])).rows[0].id;
    await require('../src/services/account.service').setStatus(accountId, 'read_only', 'test');
    assert.equal((await ok(customer, 'list_my_tenders', {})).items.length, 1);
    const readOnly = await tool(customer, 'create_tender_draft', { title: 'x' });
    assert.equal(readOnly.structuredContent.error.code, 'ACCOUNT_READ_ONLY');
    await customer.close();
    await chosen.close();
    process.stdout.write('deal mcp scenario passed\n');
  } finally {
    server.close();
  }
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
