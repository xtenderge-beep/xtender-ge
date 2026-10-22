// Аккаунт и профиль исполнителя в API v1: роли считает сервер (заказчик — у всех, исполнитель — по профилю с тем
// же номером, заблокированный — только заказчик); роль и чужие данные нельзя получить полями запроса; правка только
// с актуальной версией (If-Match, 428/412); исполнитель меняет сам только языки и приём заявок, остальное —
// модератор (422 MODERATOR_ONLY); регистрации исполнителя через API нет (409 со ссылкой на /join); правка видна
// в журнале действий исполнителя в админке. Тексты ka/ru/en сохраняются без искажений.
const assert = require('node:assert/strict');
const harness = require('./api-v1-harness');

(async () => {
  const { server, base } = await harness.start();
  const call = harness.client(base);
  try {
    const provider = await harness.addMaster({ phone: '+995522000001', service: 'van', attributes: { size: 'M', body: 'closed' }, languages: ['ka', 'ru'], name: 'Шота' });
    const pending = await harness.addMaster({ phone: '+995522000002', service: 'movers', active: false });
    const banned = await harness.addMaster({ phone: '+995522000003', service: 'movers', banned: true });
    await harness.pool.query('INSERT INTO orders (token, owner_token, description, phone, status) VALUES ($1,$2,$3,$4,$5)', ['ordtoken01', 'owner00001', 'test', '+995500000099', 'closed']);
    const orderId = (await harness.pool.query('SELECT id FROM orders')).rows[0].id;
    await harness.pool.query('INSERT INTO master_reviews (master_id, order_id, rating, is_approved) VALUES ($1,$2,5,true)', [provider.id, orderId]);

    // 1. Заказчик без профиля исполнителя.
    const customer = await harness.login(base, '+995522000009');
    let r = await call('GET', '/api/v1/me?user_id=usr_00000000000000000000', { token: customer.access_token });
    assert.equal(r.status, 200);
    const me = r.json;
    assert.deepEqual([me.roles, me.provider, me.locale, me.timezone, me.masked_phone], [['customer'], null, 'ka', 'Asia/Tbilisi', '+995 5•• •• •• 09']);
    assert.ok(!JSON.stringify(me).includes('522000009'), 'полного номера в ответе нет');
    assert.equal(r.headers.get('etag'), '"1"');
    assert.match(r.headers.get('cache-control'), /private, no-store/);
    assert.ok(!me.available_actions.includes('update_provider_profile'));
    r = await call('GET', '/api/v1/me/provider-profile?lang=ru', { token: customer.access_token });
    assert.deepEqual([r.status, r.json.error.code, r.json.registration_url], [404, 'PROVIDER_PROFILE_NOT_FOUND', base + '/ru/join']);
    r = await call('PUT', '/api/v1/me/provider-profile', { token: customer.access_token, body: { languages: ['ru'] }, headers: { 'if-match': '"x"' } });
    assert.deepEqual([r.status, r.json.error.code], [409, 'PROVIDER_REGISTRATION_REQUIRED'], 'роль исполнителя через API не выдаётся');
    const caps = (await call('GET', '/api/v1/capabilities', { token: customer.access_token })).json;
    assert.equal(caps.actions.find((a) => a.id === 'get_provider_profile').unavailable_reason, 'role_required:provider');

    // 2. PATCH /me: версия обязательна, роль и номер не пишутся, значения проверяются, текст не искажается.
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: { locale: 'ru' } });
    assert.deepEqual([r.status, r.json.error.code], [428, 'PRECONDITION_REQUIRED']);
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: { roles: ['customer', 'provider', 'admin'], phone: '+995599999999', id: 'usr_x' }, headers: { 'if-match': '"1"' } });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json.error.fields.map((f) => [f.path, f.code]), [['roles', 'FIELD_NOT_WRITABLE'], ['phone', 'FIELD_NOT_WRITABLE'], ['id', 'FIELD_NOT_WRITABLE']]);
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: { timezone: 'Mars/Olympus', locale: 'de', display_name: 'Звоните 599 12 34 56' }, headers: { 'if-match': '"1"' } });
    assert.deepEqual(r.json.error.fields.map((f) => [f.path, f.code]), [['display_name', 'CONTAINS_PHONE'], ['locale', 'INVALID_VALUE'], ['timezone', 'INVALID_VALUE']]);
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: { display_name: '  გიორგი ბერიძე  ', locale: 'ru', timezone: 'Europe/Moscow' }, headers: { 'if-match': '"1"' } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.display_name, r.json.locale, r.json.timezone, r.json.version, r.headers.get('etag')], ['გიორგი ბერიძე', 'ru', 'Europe/Moscow', 2, '"2"']);
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: { display_name: 'Другое' }, headers: { 'if-match': '"1"' } });
    assert.deepEqual([r.status, r.json.error.code, r.json.current_version], [412, 'VERSION_MISMATCH', 2]);
    r = await call('PATCH', '/api/v1/me', { token: customer.access_token, body: '{"locale":', headers: { 'if-match': '"2"' } });
    assert.deepEqual([r.status, r.json.error.code], [400, 'INVALID_JSON']);
    assert.equal((await call('GET', '/api/v1/me', { token: customer.access_token })).json.display_name, 'გიორგი ბერიძე');
    assert.equal((await call('GET', '/api/v1/units', { token: customer.access_token })).json.language, 'ru', 'язык ответа — язык аккаунта');

    // 3. Исполнитель: профиль из masters, master_services, master_cities, отзывов.
    const session = await harness.login(base, '+995522000001');
    r = await call('GET', '/api/v1/me', { token: session.access_token });
    assert.deepEqual([r.json.roles, r.json.provider.status], [['customer', 'provider'], 'active']);
    r = await call('GET', '/api/v1/me/provider-profile?lang=en', { token: session.access_token });
    let profile = r.json;
    assert.equal(r.headers.get('etag'), `"${profile.version}"`);
    assert.deepEqual([profile.status, profile.display_name, profile.category_ids, profile.service_area_ids, profile.languages, profile.availability_status],
      ['active', 'Shota', ['van'], ['city:tbilisi'], ['ka', 'ru'], 'available']);
    assert.deepEqual(profile.services[0], { category_id: 'van', active: true, is_primary: true, attributes: { size: 'M', body: 'closed' } });
    assert.deepEqual([profile.rating, profile.review_count, profile.verification_status, profile.billing_mode], [5, 1, 'approved_by_moderator', 'free_period']);

    // 4. PUT: без версии, со старой версией, с модерируемым или неизвестным полем — отказ; профиль не изменился.
    const put = (body, version = profile.version) => call('PUT', '/api/v1/me/provider-profile?lang=en', { token: session.access_token, body, headers: version ? { 'if-match': `"${version}"` } : {} });
    assert.equal((await put({ languages: ['ru'] }, null)).status, 428);
    assert.equal((await put({ languages: ['ru'] }, 'pv_0000000000000000')).json.error.code, 'VERSION_MISMATCH');
    r = await put({ ...profile, category_ids: ['van', 'movers'], service_area_ids: ['city:tbilisi', 'city:batumi'], description: { original_text: 'Лучший' }, languages: ['ru'] });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json.error.fields.map((f) => [f.path, f.code]), [['category_ids', 'MODERATOR_ONLY'], ['service_area_ids', 'MODERATOR_ONLY'], ['description', 'MODERATOR_ONLY']]);
    r = await put({ languages: ['xx'], availability_status: 'busy', is_banned: false, balance_tetri: 100000 });
    assert.deepEqual(r.json.error.fields.map((f) => [f.path, f.code]), [['is_banned', 'UNKNOWN_FIELD'], ['balance_tetri', 'UNKNOWN_FIELD'], ['languages', 'INVALID_VALUE'], ['availability_status', 'INVALID_VALUE']]);
    const stored = (await harness.pool.query('SELECT spoken_languages, is_subscribed, balance_tetri FROM masters WHERE id=$1', [provider.id])).rows[0];
    assert.deepEqual([stored.spoken_languages, stored.is_subscribed, stored.balance_tetri], [['ka', 'ru'], true, 0]);

    // 5. Весь объект обратно, с изменёнными языками и приёмом заявок: принято, версия новая, журнал в админке.
    r = await put({ ...profile, languages: ['en', 'ka'], availability_status: 'unsubscribed', rating: 1 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.languages, r.json.availability_status, r.json.rating], [['en', 'ka'], 'unsubscribed', 5]);
    assert.notEqual(r.json.version, profile.version);
    const after = (await harness.pool.query('SELECT spoken_languages, is_subscribed FROM masters WHERE id=$1', [provider.id])).rows[0];
    assert.deepEqual([after.spoken_languages, after.is_subscribed], [['en', 'ka'], false]);
    const events = (await harness.pool.query('SELECT actor, action, body FROM master_admin_events WHERE master_id=$1 ORDER BY id', [provider.id])).rows;
    assert.deepEqual(events.map((e) => [e.actor, e.action]), [['Исполнитель', 'edit_languages'], ['Исполнитель', 'leads_off']]);
    assert.match(events[0].body, /Английский, Грузинский \(API\)/);
    assert.match(events[1].body, /приложение через API/);
    profile = r.json;
    assert.equal((await put({ ...profile })).status, 200, 'без изменений — тоже успех, версия та же');
    // Изменение из другого места (кабинет, админка) делает прежнюю версию устаревшей.
    await harness.pool.query('UPDATE masters SET is_subscribed = true WHERE id=$1', [provider.id]);
    assert.equal((await put({ availability_status: 'unsubscribed' })).status, 412);

    // 6. На модерации — исполнитель со статусом pending; заблокированный — только заказчик, правка запрещена.
    const pendingSession = await harness.login(base, '+995522000002');
    r = await call('GET', '/api/v1/me/provider-profile', { token: pendingSession.access_token });
    assert.deepEqual([r.json.status, r.json.verification_status], ['pending', 'pending_moderation']);
    const bannedSession = await harness.login(base, '+995522000003');
    r = await call('GET', '/api/v1/me', { token: bannedSession.access_token });
    assert.deepEqual([r.json.roles, r.json.provider.status], [['customer'], 'banned']);
    const bannedProfile = (await call('GET', '/api/v1/me/provider-profile', { token: bannedSession.access_token })).json;
    r = await call('PUT', '/api/v1/me/provider-profile', { token: bannedSession.access_token, body: { languages: ['ru'] }, headers: { 'if-match': `"${bannedProfile.version}"` } });
    assert.deepEqual([r.status, r.json.error.code], [403, 'PROVIDER_BLOCKED']);
    assert.ok(pending.id && banned.id);
  } finally {
    server.close();
  }
  process.stdout.write('api v1 profile tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
