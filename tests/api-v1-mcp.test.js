// Этап 1б: вход в MCP-сервер /mcp токеном OAuth, как это делает ChatGPT (docs/api-v1/BACKEND_AUDIT.md, раздел 13).
// tools/list несёт securitySchemes каждого инструмента; без токена get_my_account просит подключить аккаунт через
// _meta["mcp/www_authenticate"], а прежние инструменты работают; неверный токен — HTTP 401 с WWW-Authenticate;
// токен, выданный на ресурс /mcp, открывает аккаунт; отключение сессии и блокировка аккаунта закрывают доступ сразу.
const assert = require('node:assert/strict');
const harness = require('./api-v1-harness');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PHONE = '+995533000001';

(async () => {
  const { server, base } = await harness.start();
  const rpc = (body, token) => fetch(base + '/mcp', { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  const connect = async (token) => {
    const client = new Client({ name: 'chatgpt-like', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), token ? { requestInit: { headers: { authorization: 'Bearer ' + token } } } : {}));
    return client;
  };
  try {
    await harness.addMaster({ phone: PHONE, service: 'movers' });

    // 1. Корневые метаданные ресурса описывают /mcp (их читает ChatGPT), у REST — свой адрес.
    const root = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
    assert.deepEqual([root.resource, root.authorization_servers], [base + '/mcp', [base]]);
    assert.equal((await (await fetch(base + '/.well-known/oauth-protected-resource/api/v1')).json()).resource, base + '/api/v1');

    // 2. tools/list: у каждого инструмента securitySchemes (библиотека MCP его не передаёт — дописывает сервер).
    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json();
    const schemes = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool.securitySchemes]));
    assert.deepEqual(schemes, {
      list_services: [{ type: 'noauth' }],
      create_request_link: [{ type: 'noauth' }],
      get_my_account: [{ type: 'oauth2', scopes: ['profile:read'] }],
    });

    // 3. Без токена: прежние инструменты работают, get_my_account просит подключить аккаунт.
    const anonymous = await connect();
    assert.ok(!(await anonymous.callTool({ name: 'list_services', arguments: {} })).isError);
    const asked = await anonymous.callTool({ name: 'get_my_account', arguments: {} });
    assert.equal(asked.isError, true);
    const challenge = asked._meta['mcp/www_authenticate'][0];
    assert.match(challenge, new RegExp(`^Bearer resource_metadata="${base}/\\.well-known/oauth-protected-resource"`));
    assert.match(challenge, /error="insufficient_scope", error_description="Connect your xtender\.ge account to continue"/);
    await anonymous.close();

    // 4. Неверный токен — HTTP 401 с адресом метаданных: клиент подключает аккаунт заново.
    const bad = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'xat_' + 'x'.repeat(43));
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/\\.well-known/oauth-protected-resource", error="invalid_token"`));

    // 5. Вход, как у ChatGPT: регистрация с адресом ChatGPT нужна только на проде; здесь — тот же поток со своим адресом,
    // токен на ресурс /mcp. С токеном инструмент отдаёт аккаунт без полного номера.
    await harness.resetLimits(PHONE);
    const { obtainToken } = require('../scripts/api-sandbox-token');
    const tokens = await obtainToken({ base, phone: PHONE, scope: 'profile:read profile:write' });
    const grant = (await harness.pool.query("SELECT resource FROM oauth_grants WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(grant.resource, base + '/api/v1', 'скрипт песочницы просит ресурс REST');
    const mcpTokens = await (async () => {
      await harness.resetLimits(PHONE);
      const crypto = require('node:crypto');
      const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'ChatGPT test', redirect_uris: ['http://127.0.0.1:8976/callback'] }) })).json();
      const verifier = crypto.randomBytes(32).toString('base64url');
      const page = await fetch(base + '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:8976/callback',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'profile:read profile:write', resource: base + '/mcp', state: 's' }));
      const cookie = page.headers.get('set-cookie').split(';')[0];
      const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())[1];
      const form = (path, fields) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ request_id: requestId, ...fields }) });
      await form('/oauth/authorize/phone', { phone: PHONE });
      const sms = await (await fetch(base + '/api/v1/sandbox/sms?phone=' + encodeURIComponent(PHONE))).json();
      await form('/oauth/authorize/code', { code: /code: (\d{4})/.exec(sms.items[0].text)[1], action: 'verify' });
      const back = new URL((await form('/oauth/authorize/decision', { decision: 'allow' })).headers.get('location'));
      return (await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'http://127.0.0.1:8976/callback', client_id: reg.client_id, code_verifier: verifier, resource: base + '/mcp' }) })).json();
    })();
    assert.ok(mcpTokens.access_token, JSON.stringify(mcpTokens));
    for (const token of [mcpTokens.access_token, tokens.access_token]) {
      const client = await connect(token);
      const result = await client.callTool({ name: 'get_my_account', arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.deepEqual([result.structuredContent.roles, result.structuredContent.masked_phone, result.structuredContent.provider_status],
        [['customer', 'provider'], '+995 5•• •• •• 01', 'active']);
      assert.ok(!JSON.stringify(result).includes('533000001'), 'полного номера нет');
      await client.close();
    }

    // 6. Отключение сессии и блокировка аккаунта закрывают доступ к инструменту сразу.
    await fetch(base + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: mcpTokens.access_token }) });
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, mcpTokens.access_token)).status, 401);
    const accountId = (await harness.pool.query('SELECT id FROM accounts WHERE phone=$1', [PHONE])).rows[0].id;
    await require('../src/services/account.service').setStatus(accountId, 'blocked', 'test');
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, tokens.access_token)).status, 401);
  } finally {
    server.close();
  }
  process.stdout.write('api v1 mcp tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
