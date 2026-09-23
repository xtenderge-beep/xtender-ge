const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const { displayName, resolve, validateOverride } = require('../src/config/providerName');
for (const [input, expected] of [
  ['Александр Иванов','Aleksandr Ivanov'], ['Юрий Щукин','Yuriy Shchukin'],
  ['СЕМЁН','SEMYON'], ['Анна-Мария','Anna-Mariya'], ['Игорь','Igor'],
  ['გიორგი ბერიძე','Giorgi Beridze'], ['შოთა','Shota'], ['ნინო','Nino'],
  ['ᲒᲘᲝᲠᲒᲘ','Giorgi'], ['John Smith','John Smith'], ['José O’Neil','José O’Neil'],
  ['Давид / გიორგი 24','David / Giorgi 24'], ['', ''], [null, ''],
]) assert.equal(displayName(input), expected);

// Admin override wins over automatic transliteration; blank override falls back to it.
assert.equal(resolve({ name:'Александр Иванов', display_name_override:'Alex' }), 'Alex');
assert.equal(resolve({ name:'Александр Иванов', display_name_override:'  ' }), 'Aleksandr Ivanov');
assert.equal(resolve({ name:'Александр Иванов', display_name_override:null }), 'Aleksandr Ivanov');
assert.equal(validateOverride('  Alex  '), 'Alex');
assert.equal(validateOverride(''), '');
assert.equal(validateOverride('x'.repeat(121)), null);
assert.equal(validateOverride('x'.repeat(120)), 'x'.repeat(120));

const db = require('pg-mem').newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
pool.withTransaction = async fn => {
  const backup = db.backup();
  try { return await fn(pool); } catch (error) { backup.restore(); throw error; }
};
const stub = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
stub('../src/config/db', pool);
const redis = new (require('ioredis-mock'))();
stub('../src/config/redis', redis);
const masters = require('../src/services/master.service');
const contacts = require('../src/config/catalogContacts');
let server;
(async () => {
  const master = (await pool.query("INSERT INTO masters(name,phone,master_token,category,is_active,balance_tetri) VALUES('გიორგი ბერიძე','+995500000701','name-test','movers',true,1000) RETURNING *")).rows[0];
  await pool.query("INSERT INTO master_services(master_id,service_type,attributes,is_primary) VALUES($1,'movers','{}',true)", [master.id]);
  await masters.saveContacts(master.master_token, { whatsapp:'', viber:'+995500000702', telegram:'example_name' }, ['ka']);
  await require('./billing-fixture')(pool, master.id);
  await masters.revealPhoneForCall(master.id, 50, '+995500000703');

  process.env.ADMIN_SESSION_SECRET = 'synthetic-admin-test-secret';
  process.env.ADMIN_PASSWORD = 'synthetic-admin-test-password';
  const auth = require('../src/config/adminAuth');
  const session = auth.createSessionValue();
  const csrf = auth.verifySessionValue(session.cookieValue).csrfToken;
  const app = require('express')();
  app.use(require('express').urlencoded({ extended:false }));
  app.use(require('cookie-parser')());
  app.use('/admin', require('../src/routes/admin.routes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/admin/masters/${master.id}/whatsapp`;
  const post = (body, loggedIn = true) => fetch(endpoint, {
    method:'POST', redirect:'manual', headers: loggedIn ? {cookie:`${auth.SESSION_COOKIE}=${session.cookieValue}`} : {},
    body:new URLSearchParams(body),
  });
  let response = await post({whatsapp:'+995500000704'}, false);
  assert.equal(response.headers.get('location'), '/admin/login');
  response = await post({whatsapp:'+995500000704'}); assert.equal(response.status, 403);
  response = await post({_csrf:csrf, whatsapp:'javascript:alert(1)'});
  assert.ok(response.headers.get('location').includes('invalid_whatsapp'));
  response = await post({_csrf:csrf, whatsapp:'+995 (500) 000-704'});
  assert.ok(response.headers.get('location').includes('saved=whatsapp'));
  let saved = await masters.getMasterByToken(master.master_token);
  assert.equal(saved.name, master.name); assert.equal(saved.phone, master.phone);
  assert.deepEqual(saved.contact_channels, {whatsapp:'+995500000704',viber:'+995500000702',telegram:'example_name'});
  assert.equal((await masters.listMasters())[0].display_name, 'Giorgi Beridze');
  const repeated = await masters.revealPhoneForCall(master.id, 50, '+995500000703');
  assert.equal(repeated.alreadyOpened, true);
  assert.equal(contacts.links(repeated).whatsapp, 'https://wa.me/995500000704');
  assert.equal(repeated.balance_tetri, 950);
  assert.equal((await pool.query("SELECT * FROM balance_transactions WHERE reason='catalog_call'")).rows.length, 1);
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/admin/_master-whatsapp.ejs'), {master:saved, csrfToken:csrf, error:null, whatsappSaved:true});
  assert.ok(html.includes('value="+995500000704"'));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  await post({_csrf:csrf, whatsapp:''});
  saved = await masters.getMasterByToken(master.master_token);
  assert.equal(contacts.links(saved).whatsapp, undefined);
  assert.equal(saved.contact_channels.telegram, 'example_name');

  // --- Admin manual override of the transliterated display name ---
  const nameEndpoint = endpoint.replace('/whatsapp', '/display-name');
  const postName = (body, loggedIn = true) => fetch(nameEndpoint, {
    method:'POST', redirect:'manual', headers: loggedIn ? {cookie:`${auth.SESSION_COOKIE}=${session.cookieValue}`} : {},
    body:new URLSearchParams(body),
  });
  response = await postName({displayName:'Alex'}, false);
  assert.equal(response.headers.get('location'), '/admin/login');
  response = await postName({displayName:'Alex'}); assert.equal(response.status, 403);
  response = await postName({_csrf:csrf, displayName:'x'.repeat(121)});
  assert.ok(response.headers.get('location').includes('invalid_displayname'));
  response = await postName({_csrf:csrf, displayName:'  Alex G.  '});
  assert.ok(response.headers.get('location').includes('saved=displayname'));
  saved = await masters.getMasterByToken(master.master_token);
  assert.equal(saved.display_name_override, 'Alex G.');
  assert.equal(saved.name, master.name); // original untouched
  assert.equal((await masters.listMasters())[0].display_name, 'Alex G.'); // override wins in catalog
  const nameHtml = await ejs.renderFile(path.join(__dirname, '../src/views/admin/_master-display-name.ejs'), {master:saved, csrfToken:csrf, error:null, displayNameSaved:true, autoDisplayName:'Giorgi Beridze'});
  assert.ok(nameHtml.includes('value="Alex G."'));
  for (const script of nameHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  await postName({_csrf:csrf, displayName:''}); // clears override, reverts to automatic
  saved = await masters.getMasterByToken(master.master_token);
  assert.equal(saved.display_name_override, null);
  assert.equal((await masters.listMasters())[0].display_name, 'Giorgi Beridze');

  console.log('PASS: Russian/Georgian display names, original data preserved, authenticated CSRF-protected admin WhatsApp editing, other channels preserved, no repeat charge, admin display-name override wins and clears back to automatic');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); redis.disconnect(); });
