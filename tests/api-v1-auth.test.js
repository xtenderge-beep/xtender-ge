// Вход OAuth для API v1 (docs/api-v1/AUTH.md): метаданные для ChatGPT, регистрация клиента и разрешённые адреса
// возврата, страница входа по номеру и коду из SMS (через приёмник песочницы), PKCE, одноразовый код, ротация
// refresh-токена с отключением сессии при повторе, отзыв, области доступа, отключённый аккаунт, лимит запросов,
// и что токены и номера не попадают в журнал сервера.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const harness = require('./api-v1-harness');

const CUSTOMER = '+995511000001';
const OTHER = '+995511000002';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

(async () => {
  const { server, base } = await harness.start();
  const call = harness.client(base);
  const form = (url, fields, headers = {}) => fetch(base + url, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
  try {
    // 1. Метаданные: то, что ChatGPT читает до входа (developers.openai.com/plugins/build/auth).
    const as = (await call('GET', '/.well-known/oauth-authorization-server')).json;
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.registration_endpoint, base + '/oauth/register');
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(as.scopes_supported, ['profile:read', 'profile:write'], 'объявлены только области со сделанными операциями');
    const prm = (await call('GET', '/.well-known/oauth-protected-resource/api/v1')).json;
    assert.equal(prm.resource, base + '/api/v1');
    assert.deepEqual(prm.authorization_servers, [as.issuer], 'issuer совпадает побайтно');
    assert.equal((await call('GET', '/.well-known/oauth-protected-resource/mcp')).json.resource, base + '/mcp');

    // 2. Регистрация клиента: только разрешённые адреса возврата и публичный клиент.
    const register = (body) => call('POST', '/oauth/register', { body });
    assert.equal((await register({ redirect_uris: ['https://evil.example/callback'] })).json.error, 'invalid_redirect_uri');
    assert.equal((await register({ redirect_uris: ['https://chatgpt.com.evil.example/connector_platform_oauth_redirect'] })).json.error, 'invalid_redirect_uri');
    assert.equal((await register({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'client_secret_basic' })).json.error, 'invalid_client_metadata');
    const gpt = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc123'] });
    assert.equal(gpt.status, 201);
    assert.equal(gpt.json.token_endpoint_auth_method, 'none');
    assert.ok(gpt.json.client_id.startsWith('xtc_'));
    const evil = await register({ client_name: 'Evil "app" & <script>alert(1)</script>', redirect_uris: ['http://127.0.0.1:8976/callback'] });
    assert.equal(evil.status, 201);

    // 3. Ошибки запроса входа: без подтверждённого клиента и адреса — страница, без перехода; остальное — назад к клиенту с iss.
    const authorizeUrl = (params) => base + '/oauth/authorize?' + new URLSearchParams(params);
    const { verifier, challenge } = pkce();
    const valid = { response_type: 'code', client_id: evil.json.client_id, redirect_uri: 'http://127.0.0.1:8976/callback', state: 'st1', code_challenge: challenge, code_challenge_method: 'S256', scope: 'profile:read' };
    let page = await fetch(authorizeUrl({ ...valid, client_id: 'xtc_unknown' }), { redirect: 'manual' });
    assert.equal(page.status, 400);
    page = await fetch(authorizeUrl({ ...valid, redirect_uri: 'http://127.0.0.1:8976/other' }), { redirect: 'manual' });
    assert.equal(page.status, 400, 'чужой адрес возврата — без перехода');
    page = await fetch(authorizeUrl({ ...valid, code_challenge: undefined }), { redirect: 'manual' });
    let back = new URL(page.headers.get('location'));
    assert.deepEqual([page.status, back.searchParams.get('error'), back.searchParams.get('state'), back.searchParams.get('iss')], [302, 'invalid_request', 'st1', base]);
    page = await fetch(authorizeUrl({ ...valid, code_challenge_method: 'plain' }), { redirect: 'manual' });
    assert.equal(new URL(page.headers.get('location')).searchParams.get('error'), 'invalid_request', 'только S256');
    page = await fetch(authorizeUrl({ ...valid, scope: 'admin' }), { redirect: 'manual' });
    assert.equal(new URL(page.headers.get('location')).searchParams.get('error'), 'invalid_scope');
    page = await fetch(authorizeUrl({ ...valid, scope: 'profile:read tenders:write' }), { redirect: 'manual' });
    assert.equal(new URL(page.headers.get('location')).searchParams.get('error'), 'invalid_scope', 'заявок через API ещё нет — и доступа к ним не просим');
    page = await fetch(authorizeUrl({ ...valid, resource: 'https://other.example/api' }), { redirect: 'manual' });
    assert.equal(new URL(page.headers.get('location')).searchParams.get('error'), 'invalid_target');

    // 4. Страница входа по шагам. Имя клиента — чужие данные: только экранированное.
    await harness.resetLimits(CUSTOMER);
    page = await fetch(authorizeUrl({ ...valid, ui_locales: 'ru' }), { redirect: 'manual' });
    assert.equal(page.status, 200);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    let html = await page.text();
    assert.ok(!html.includes('<script>alert(1)'), 'теги из имени клиента не попадают на страницу');
    assert.ok(html.includes('Evil &#34;app&#34; &amp; scriptalert(1)/script'), 'имя клиента экранировано');
    assert.match(html, /Подключение аккаунта xtender\.ge/);
    assert.match(html, /Видеть ваш профиль/);
    assert.match(page.headers.get('cache-control'), /no-store/);
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)[1];
    let step = await form('/oauth/authorize/phone', { request_id: requestId, phone: '+7 999 123 45 67' }, { cookie });
    assert.equal(step.status, 400, 'только грузинские номера');
    step = await form('/oauth/authorize/phone', { request_id: requestId, phone: CUSTOMER }, { cookie: 'oauth_request=forged' });
    assert.equal(step.status, 403, 'без куки этой вкладки вход не продолжить');
    step = await form('/oauth/authorize/phone', { request_id: requestId, phone: '511 000 001' }, { cookie });
    assert.equal(step.status, 200, 'номер без +995 приводится к E.164');
    html = await step.text();
    assert.match(html, /Код отправлен на \+995 5•• •• •• 01/);
    const sms = (await call('GET', '/api/v1/sandbox/sms?phone=' + encodeURIComponent(CUSTOMER))).json.items[0];
    assert.match(sms.text, /^Xtender code: \d{4}\. Enter it on xtender\.ge to connect an app to your account\. Never share it in a chat\./);
    assert.ok(sms.text.length <= 140 && /^[\x20-\x7e]+$/.test(sms.text), 'SMS латиницей, в один сегмент');
    const code = /code: (\d{4})/.exec(sms.text)[1];
    step = await form('/oauth/authorize/code', { request_id: requestId, code: code === '1111' ? '2222' : '1111', action: 'verify' }, { cookie });
    assert.equal(step.status, 400);
    step = await form('/oauth/authorize/decision', { request_id: requestId, decision: 'allow' }, { cookie });
    assert.equal(step.status, 400, 'без проверенного кода разрешить нельзя');
    step = await form('/oauth/authorize/code', { request_id: requestId, code, action: 'verify' }, { cookie });
    assert.equal(step.status, 200);
    assert.match(await step.text(), /Разрешить доступ\?[\s\S]*Полный номер телефона приложение не получит/);
    const verifiedRow = (await harness.pool.query("SELECT event_type, metadata FROM sms_consent_logs WHERE purpose='oauth' AND event_type='OAUTH_SMS_OTP_VERIFIED'")).rows[0];
    assert.equal(verifiedRow.metadata.client_id, evil.json.client_id, 'подтверждение номера — в журнале согласий с клиентом');
    step = await form('/oauth/authorize/decision', { request_id: requestId, decision: 'allow' }, { cookie });
    assert.equal(step.status, 302);
    back = new URL(step.headers.get('location'));
    assert.equal(back.origin + back.pathname, 'http://127.0.0.1:8976/callback');
    assert.deepEqual([back.searchParams.get('state'), back.searchParams.get('iss')], ['st1', base]);
    const authCode = back.searchParams.get('code');
    assert.ok(authCode && authCode.length >= 40);
    assert.equal((await harness.pool.query('SELECT COUNT(*)::int AS n FROM oauth_authorization_codes WHERE code_hash=$1', [authCode])).rows[0].n, 0, 'код хранится только хешем');
    assert.equal((await form('/oauth/authorize/decision', { request_id: requestId, decision: 'allow' }, { cookie })).status, 400, 'запрос входа одноразовый');

    // 5. Обмен кода: PKCE, тот же адрес и клиент; повтор кода отключает выданное по нему.
    const exchange = (fields) => form('/oauth/token', { grant_type: 'authorization_code', client_id: evil.json.client_id, redirect_uri: valid.redirect_uri, ...fields }).then((r) => r.json());
    assert.equal((await exchange({ code: authCode, code_verifier: pkce().verifier })).error, 'invalid_grant', 'чужой verifier');
    assert.equal((await exchange({ code: authCode, code_verifier: verifier, client_id: gpt.json.client_id })).error, 'invalid_grant', 'другой клиент');
    const tokens = await exchange({ code: authCode, code_verifier: verifier });
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'profile:read');
    assert.ok(tokens.access_token.startsWith('xat_') && tokens.refresh_token.startsWith('xrt_'));
    assert.equal((await call('GET', '/api/v1/me', { token: tokens.access_token })).status, 200);
    assert.equal((await exchange({ code: authCode, code_verifier: verifier })).error, 'invalid_grant');
    assert.equal((await call('GET', '/api/v1/me', { token: tokens.access_token })).status, 401, 'повтор кода отключил сессию');

    // 6. Ротация refresh-токена; повтор старого отключает сессию.
    let session = await harness.login(base, CUSTOMER);
    const refresh = (token, clientId = session.client_id) => form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId }).then((r) => r.json());
    assert.equal((await refresh(session.refresh_token, gpt.json.client_id)).error, 'invalid_grant', 'refresh чужого клиента');
    const rotated = await refresh(session.refresh_token);
    assert.ok(rotated.access_token && rotated.refresh_token !== session.refresh_token);
    assert.equal((await call('GET', '/api/v1/me', { token: rotated.access_token })).status, 200);
    assert.equal((await refresh(session.refresh_token)).error, 'invalid_grant');
    assert.equal((await call('GET', '/api/v1/me', { token: rotated.access_token })).status, 401, 'повтор refresh отключил сессию');

    // 7. Отзыв по RFC 7009: всегда 200; отзыв токена отключает сессию.
    session = await harness.login(base, CUSTOMER);
    assert.equal((await form('/oauth/revoke', { token: 'xat_unknown_token_value_123456', client_id: session.client_id })).status, 200);
    assert.equal((await form('/oauth/revoke', { token: session.access_token, client_id: session.client_id })).status, 200);
    assert.equal((await call('GET', '/api/v1/me', { token: session.access_token })).status, 401);
    assert.equal((await refresh(session.refresh_token)).error, 'invalid_grant');

    // 8. API без токена, с неверным токеном и без нужной области.
    let r = await call('GET', '/api/v1/me');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), new RegExp(`^Bearer resource_metadata="${base}/\\.well-known/oauth-protected-resource/api/v1"`));
    assert.ok(r.json.request_id.startsWith('req_') && r.headers.get('x-request-id') === r.json.request_id);
    r = await call('GET', '/api/v1/me', { token: 'xat_' + 'a'.repeat(43) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
    const readOnly = await harness.login(base, CUSTOMER, 'profile:read');
    r = await call('PATCH', '/api/v1/me', { token: readOnly.access_token, body: { locale: 'ru' }, headers: { 'if-match': '"1"' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'INSUFFICIENT_SCOPE');
    assert.match(r.headers.get('www-authenticate'), /error="insufficient_scope", .*scope="profile:write"/);
    const caps = (await call('GET', '/api/v1/capabilities', { token: readOnly.access_token })).json;
    assert.equal(caps.actions.find((a) => a.id === 'update_my_profile').unavailable_reason, 'scope_required:profile:write');

    // 9. Подключённые приложения: своё отключается, чужое — тот же 404, что и несуществующее.
    const mine = await harness.login(base, CUSTOMER);
    const other = await harness.login(base, OTHER);
    const sessions = (await call('GET', '/api/v1/me/sessions', { token: mine.access_token })).json.items;
    assert.ok(sessions.some((s) => s.current) && sessions.every((s) => s.client_name === 'Sandbox CLI'));
    const otherSession = (await call('GET', '/api/v1/me/sessions', { token: other.access_token })).json.items.find((s) => s.current);
    r = await call('DELETE', '/api/v1/me/sessions/' + otherSession.id, { token: mine.access_token });
    assert.equal(r.status, 404);
    assert.equal((await call('GET', '/api/v1/me', { token: other.access_token })).status, 200, 'чужая сессия не тронута');
    assert.equal((await call('DELETE', '/api/v1/me/sessions/grt_00000000000000000000', { token: mine.access_token })).status, 404);
    r = await call('DELETE', '/api/v1/me/sessions/' + otherSession.id, { token: other.access_token });
    assert.deepEqual([r.status, r.json.revoked], [200, true]);
    assert.equal((await call('GET', '/api/v1/me', { token: other.access_token })).status, 401);

    // 10. Просроченный токен и отключённый аккаунт (читает, но не пишет).
    await harness.pool.query("UPDATE oauth_tokens SET expires_at = $1 WHERE kind='access' AND grant_id IN (SELECT id FROM oauth_grants WHERE account_id IN (SELECT id FROM accounts WHERE phone=$2))", [new Date(Date.now() - 1000), CUSTOMER]);
    assert.equal((await call('GET', '/api/v1/me', { token: mine.access_token })).status, 401);
    const fresh = await harness.login(base, CUSTOMER);
    await harness.pool.query("UPDATE accounts SET status='disabled' WHERE phone=$1", [CUSTOMER]);
    r = await call('GET', '/api/v1/me', { token: fresh.access_token });
    assert.deepEqual([r.status, r.json.account_status], [200, 'disabled']);
    r = await call('PATCH', '/api/v1/me', { token: fresh.access_token, body: { locale: 'ru' }, headers: { 'if-match': '"' + r.json.version + '"' } });
    assert.deepEqual([r.status, r.json.error.code], [403, 'ACCOUNT_DISABLED']);
    const disabledCaps = (await call('GET', '/api/v1/capabilities', { token: fresh.access_token })).json;
    assert.equal(disabledCaps.actions.find((a) => a.id === 'update_my_profile').unavailable_reason, 'account_disabled');
    assert.equal(disabledCaps.actions.find((a) => a.id === 'get_my_profile').available_to_user, true);
    await harness.pool.query("UPDATE accounts SET status='active' WHERE phone=$1", [CUSTOMER]);

    // 11. Лимит запросов на сессию: 120 в минуту, затем 429 с Retry-After.
    let limited = null;
    for (let i = 0; i < 250 && !limited; i++) {
      const res = await call('GET', '/api/v1/me', { token: fresh.access_token });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, '429 после лимита');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1 && limited.json.error.retryable === true);

    // 12. В журнале сервера нет токенов и номеров телефонов.
    const log = harness.logged.join('\n');
    for (const secret of [tokens.access_token, tokens.refresh_token, session.access_token, fresh.access_token, authCode]) assert.ok(!log.includes(secret), 'секрет в журнале');
    assert.ok(!/511000001|511 000 001/.test(log), 'номер в журнале');
    assert.ok(log.includes('[SMS SANDBOX]') && log.includes('[api] req_'));
  } finally {
    server.close();
  }
  process.stdout.write('api v1 auth tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
