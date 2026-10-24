// Проверка развёрнутого тестового окружения (Railway staging) перед подключением ChatGPT — docs/api-v1/OWNER_CHECK.md.
//   node scripts/staging-check.js https://<адрес> [ключ приёмника SMS]
// Только чтение и одна регистрация тестового OAuth-клиента (как это делает ChatGPT). Ничего не публикует и SMS не шлёт.
// Требования ChatGPT к входу сверены с developers.openai.com/apps-sdk/build/auth (2026-10-24).
const base = String(process.argv[2] || '').replace(/\/+$/, '');
const sinkKey = process.argv[3] || '';
// Локальная песочница (node scripts/api-sandbox.js) — для проверки самого скрипта.
if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  console.error('Usage: node scripts/staging-check.js https://<host> [sink key]  (HTTPS, no path)');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const get = async (path, init = {}) => {
  const response = await fetch(base + path, { redirect: 'manual', ...init });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, headers: response.headers, json, text };
};

(async () => {
  const health = await get('/health');
  check('сайт отвечает (/health 200)', health.status === 200, String(health.status));
  check('поиск не индексирует (X-Robots-Tag: noindex)', /noindex/.test(health.headers.get('x-robots-tag') || ''), health.headers.get('x-robots-tag') || 'нет заголовка');

  const caps = await get('/api/v1/capabilities');
  check('песочница (environment: sandbox)', caps.json?.environment === 'sandbox', caps.json?.environment);
  check('сделка включена (publish_tender supported)', caps.json?.actions?.some((a) => a.id === 'publish_tender' && a.supported));
  check('вложений нет (upload_attachment not supported)', caps.json?.actions?.some((a) => a.id === 'upload_attachment' && !a.supported));

  const as = await get('/.well-known/oauth-authorization-server');
  check('issuer = адрес окружения', as.json?.issuer === base, as.json?.issuer);
  check('PKCE S256', as.json?.code_challenge_methods_supported?.includes('S256'));
  check('регистрация клиента (registration_endpoint)', as.json?.registration_endpoint === base + '/oauth/register', as.json?.registration_endpoint);
  check('iss в ответе авторизации', as.json?.authorization_response_iss_parameter_supported === true);
  check('области сделки объявлены', ['tenders:write', 'offers:write', 'messages:write'].every((s) => as.json?.scopes_supported?.includes(s)));

  const prm = await get('/.well-known/oauth-protected-resource');
  check('метаданные ресурса описывают /mcp', prm.json?.resource === base + '/mcp', prm.json?.resource);
  check('authorization_servers = [issuer]', JSON.stringify(prm.json?.authorization_servers) === JSON.stringify([base]));

  const reg = await get('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'staging-check', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) });
  check('регистрация клиента с адресом ChatGPT', reg.status === 201 && reg.json?.client_id, String(reg.status));
  const foreign = await get('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'staging-check', redirect_uris: ['https://evil.example/callback'] }) });
  check('чужой адрес возврата отклонён', foreign.status === 400, String(foreign.status));

  const tools = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const list = tools.json?.result?.tools || [];
  check('MCP: инструменты сделки', list.some((t) => t.name === 'publish_tender'), `${list.length} инструментов`);
  check('MCP: securitySchemes у инструментов', list.find((t) => t.name === 'publish_tender')?.securitySchemes?.[0]?.type === 'oauth2');
  const badToken = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer xat_' + 'x'.repeat(43) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  check('неверный токен → 401 с resource_metadata', badToken.status === 401 && /resource_metadata=/.test(badToken.headers.get('www-authenticate') || ''), String(badToken.status));

  const search = await get('/api/v1/categories?' + new URLSearchParams({ q: 'нужны грузчики', lang: 'ru', location_id: 'city:tbilisi' }));
  const movers = search.json?.items?.find((c) => c.id === 'movers');
  check('каталог: поиск находит грузчиков', Boolean(movers));
  check('тестовые исполнители есть (SANDBOX_SEED=1)', (movers?.supply_status?.provider_count || 0) >= 2, String(movers?.supply_status?.provider_count));

  const sinkClosed = await get('/api/v1/sandbox/sms');
  check('приёмник SMS без ключа закрыт (404)', sinkClosed.status === 404, String(sinkClosed.status));
  if (sinkKey) {
    const sinkOpen = await get('/api/v1/sandbox/sms?key=' + encodeURIComponent(sinkKey));
    check('приёмник SMS с ключом открыт', sinkOpen.status === 200, String(sinkOpen.status));
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} проверок не прошли` : '\nВсё готово к подключению ChatGPT (сам вход и SMS проверяет владелец).');
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error('FAILED', error.message); process.exit(1); });
