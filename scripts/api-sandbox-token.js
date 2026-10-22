// Токен песочницы без браузера: проходит тот же вход OAuth, что человек на странице /oauth/authorize (регистрация
// клиента, PKCE, номер, код из SMS-приёмника песочницы, «Разрешить», обмен кода), и печатает ответ /oauth/token.
// Только для песочницы: на рабочем сайте кода в приёмнике нет, его присылает настоящая SMS.
//   node scripts/api-sandbox-token.js +995500000001 [scope] [base]
// Пример: node scripts/api-sandbox-token.js +995500000002 "profile:read profile:write"
const crypto = require('node:crypto');

async function obtainToken({ base = 'http://127.0.0.1:3100', phone, scope = 'profile:read profile:write', redirectUri = 'http://127.0.0.1:8976/callback', fetchImpl = fetch } = {}) {
  const json = async (response) => { const text = await response.text(); try { return JSON.parse(text); } catch { return text; } };
  const client = await json(await fetchImpl(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Sandbox CLI', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) }));
  if (!client.client_id) throw new Error('Client registration failed: ' + JSON.stringify(client));
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope, state,
    code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/api/v1' });
  const page = await fetchImpl(base + '/oauth/authorize?' + query, { redirect: 'manual' });
  const cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!cookie || !requestId) throw new Error('The sign-in page did not open (status ' + page.status + ').');
  const form = (path, fields) => fetchImpl(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ request_id: requestId, ...fields }) });
  const phoneStep = await form('/oauth/authorize/phone', { phone });
  if (phoneStep.status !== 200) throw new Error('Phone step failed: ' + phoneStep.status);
  // На тестовом сервере приёмник закрыт ключом: SANDBOX_SINK_KEY=… node scripts/api-sandbox-token.js …
  const sinkKey = process.env.SANDBOX_SINK_KEY ? '&key=' + encodeURIComponent(process.env.SANDBOX_SINK_KEY) : '';
  const sms = await json(await fetchImpl(base + '/api/v1/sandbox/sms?phone=' + encodeURIComponent(phone) + sinkKey));
  const code = /code: (\d{4})/.exec(sms.items?.[0]?.text || '')?.[1];
  if (!code) throw new Error('No code in the sandbox SMS sink: is the server running with XTENDER_SANDBOX=1?');
  const codeStep = await form('/oauth/authorize/code', { code, action: 'verify' });
  if (codeStep.status !== 200) throw new Error('Code step failed: ' + codeStep.status);
  const decision = await form('/oauth/authorize/decision', { decision: 'allow' });
  const location = new URL(decision.headers.get('location'));
  if (location.searchParams.get('state') !== state || !location.searchParams.get('code')) throw new Error('Unexpected redirect: ' + location);
  const tokens = await json(await fetchImpl(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }) }));
  if (!tokens.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(tokens));
  return { ...tokens, client_id: client.client_id };
}

if (require.main === module) {
  const [phone, scope, base] = process.argv.slice(2);
  if (!phone) { console.error('Usage: node scripts/api-sandbox-token.js +995500000001 ["profile:read profile:write"] [http://127.0.0.1:3100]'); process.exit(1); }
  obtainToken({ phone, scope: scope || undefined, base: base || undefined })
    .then((tokens) => console.log(JSON.stringify(tokens, null, 2)))
    .catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { obtainToken };
