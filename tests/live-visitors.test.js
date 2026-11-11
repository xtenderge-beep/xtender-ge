// «Сейчас на сайте» (/admin/live): вкладка шлёт сигнал → в списке видно, кто (исполнитель по сессии кабинета, заказчик по
// своей заявке в браузере, менеджер, гость) и на какой странице; токен заявки показывается номером и не сохраняется;
// закрыл вкладку — пропал, переход по сайту продолжает визит; через полторы минуты тишины запись исчезает сама; боты
// не попадают; анонимная статистика посещаемости не трогается.
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), ejs = require('ejs');
const db = require('pg-mem').newDb(); db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg(), pool = new Pool();
const stub = (p, exports) => require.cache[require.resolve(p)] = { exports };
stub('../src/config/db', pool); const redis = new (require('ioredis-mock'))(); stub('../src/config/redis', redis);
const live = require('../src/services/liveVisitors.service');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const req = (cookies = {}, ua = UA) => ({ cookies, headers: { 'user-agent': ua }, ip: '10.0.0.' + Math.floor(Math.random() * 200), hostname: 'xtender.ge' });

(async () => {
  await pool.query("INSERT INTO masters(id, name, phone, master_token, is_active) VALUES (7, 'Гиорги', '+995500000007', 'cab-7', true)");
  await pool.query("INSERT INTO orders(id, token, owner_token, phone, description, status, target_categories) VALUES (41, 'ord41tok', 'own41tok', '+995500000041', 'Диван', 'active', '{}')");
  await redis.set('master_session:' + 'a'.repeat(64), 'cab-7');

  // Исполнитель в кабинете, пришёл из Google.
  assert.equal(await live.touch(req({ master_session: 'a'.repeat(64) }), { t: 'tabprovider1', p: '/ru/master', r: 'https://www.google.com/', w: 390 }, { view: true }), true);
  // Заказчик смотрит свою заявку; исполнитель открыл заявку по ссылке из SMS; гость на странице услуги.
  await live.touch(req({ my_orders: JSON.stringify(['ord41tok']) }), { t: 'tabclient001', p: '/o/own41tok', w: 400 }, { view: true });
  await live.touch(req(), { t: 'tabguest0001', p: '/s/mushebi-tbilisi', us: 'facebook', w: 1200 }, { view: true });
  // Исполнитель открыл заявку по ссылке из SMS без входа: браузер привязан к его ссылке.
  const device = 'b'.repeat(64);
  await pool.query("INSERT INTO lead_links(order_id, master_id, key_hash, device_hash, bound_at) VALUES (41, 7, 'k', $1, NOW())", [require('crypto').createHash('sha256').update(device).digest('hex')]);
  await live.touch(req({ lead_device: device }), { t: 'tablead00001', p: '/order/ord41tok', w: 390 }, { view: true });
  await live.touch(req(), { t: 'tabstaff0001', p: '/', s: 1, w: 1200 }, { view: true });
  // Мусор и боты не попадают.
  assert.equal(await live.touch(req(), { t: 'x', p: '/' }), false);
  assert.equal(await live.touch(req({}, 'Googlebot/2.1'), { t: 'tabbot000001', p: '/' }), false);

  let now = await live.list();
  const by = tab => now.people.find(p => p.tab === tab);
  assert.deepEqual(now.counts, { total: 4, provider: 2, client: 1, manager: 0, guest: 1, staff: 1 });
  assert.deepEqual(by('tabprovider1').who, { kind: 'provider', id: 7, name: 'Гиорги', active: true });
  assert.deepEqual([by('tabprovider1').label, by('tabprovider1').pageLang, by('tabprovider1').source, by('tabprovider1').device], ['Кабинет исполнителя', 'ru', 'Google', 'mobile']);
  assert.deepEqual(by('tabclient001').who, { kind: 'client', orderId: 41, orders: 1, orderLink: '/admin/orders/ord41tok' });
  assert.deepEqual([by('tabclient001').label, by('tabclient001').detail], ['Страница заявки заказчика', 'заявка #41']);
  assert.deepEqual([by('tablead00001').who, by('tablead00001').label, by('tablead00001').detail], [{ kind: 'provider', id: 7, name: 'Гиорги', active: true, via: 'sms' }, 'Заявка (открыл исполнитель)', 'заявка #41']);
  assert.deepEqual([by('tabguest0001').detail, by('tabguest0001').source], ['/s/mushebi-tbilisi', 'facebook']);
  assert.equal(by('tabstaff0001').who.kind, 'staff');
  assert.deepEqual(now.people.slice(0, 2).map(p => p.who.kind), ['provider', 'provider'], 'исполнители первыми');
  const stored = JSON.stringify(await Promise.all((await redis.keys('live:*')).map(k => redis.get(k).catch(() => ''))));
  assert.ok(!stored.includes('ord41tok') && !stored.includes('own41tok'), 'токены заявок не сохраняются');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_visits')).rows[0].n, 0, 'анонимная статистика не трогается');

  // Переход на другую страницу в той же вкладке: «ушёл» и сразу новая страница — визит продолжается, источник тот же.
  const first = by('tabprovider1').first;
  await live.leave({ t: 'tabprovider1' });
  assert.equal((await live.list()).counts.provider, 1, 'ушёл — пропал из списка');
  await live.touch(req({ master_session: 'a'.repeat(64) }), { t: 'tabprovider1', p: '/ru/master/cab-7', w: 390 }, { view: true });
  now = await live.list();
  assert.deepEqual([by('tabprovider1').label, by('tabprovider1').source, by('tabprovider1').first, by('tabprovider1').views], ['Кабинет исполнителя', 'Google', first, 2]);
  // Сигнал с той же страницы не сбрасывает «на странице с».
  const since = by('tabprovider1').since;
  await new Promise(r => setTimeout(r, 5));
  await live.touch(req({ master_session: 'a'.repeat(64) }), { t: 'tabprovider1', p: '/ru/master/cab-7' });
  now = await live.list();
  assert.equal(by('tabprovider1').since, since);

  // Полторы минуты без сигнала — запись больше не в списке.
  const realNow = Date.now;
  Date.now = () => realNow() + live.TTL_MS + 1000;
  assert.equal((await live.list()).people.length, 0);
  Date.now = realNow;

  // Экран рендерится.
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/admin/live.ejs'), { csrfToken: 'x', navCounts: {}, live: await live.list() });
  assert.ok(html.includes('Сейчас на сайте') && html.includes("fetch('/admin/live.json'"));
  assert.ok(html.includes('data-write="') && html.includes("fetch('/admin/live/message'") && html.includes('name="_csrf" value="x"'), 'кнопка «Написать» и окно сообщения');
  console.log('PASS: live visitors — provider, client, guest, staff identified; order tokens shown as numbers and not stored; leave/continue; expiry; bots skipped; screen rendered.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => redis.disconnect());
