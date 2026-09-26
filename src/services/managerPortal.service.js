const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const pool = require('../config/db');
const redis = require('../config/redis');
const COOKIE = 'manager_session';
const TTL = 8 * 60 * 60;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/manager' };
const token = () => crypto.randomBytes(32).toString('hex');
async function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
}
async function provision(id, login, password, enabled) {
  login = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(login)) throw fail('Логин: 3–64 латинских символа, цифры, точка, дефис или подчёркивание.');
  if (password && (typeof password !== 'string' || password.length < 12 || password.length > 128)) throw fail('Пароль должен содержать 12–128 символов.');
  const passwordHash = password ? await hash(password) : null;
  return pool.withTransaction(async tx => {
    const m = (await tx.query('SELECT id, web_password_hash FROM managers WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!m) throw fail('Менеджер не найден', 404);
    if (enabled && !passwordHash && !m.web_password_hash) throw fail('Укажите пароль для первого входа.');
    try {
      await tx.query('UPDATE managers SET web_login=$2, web_password_hash=COALESCE($3,web_password_hash), web_enabled=$4, web_auth_version=web_auth_version+1 WHERE id=$1', [id, login, passwordHash, enabled]);
    } catch (e) { if (e.code === '23505') throw fail('Этот логин уже занят.'); throw e; }
    await tx.query("INSERT INTO manager_portal_events(manager_id,action,body) VALUES($1,'access_changed',$2)", [id, enabled ? 'Администратор обновил доступ; прежние сессии закрыты.' : 'Администратор отключил доступ.']);
  });
}
async function login(username, password, ip) {
  username = String(username || '').trim().toLowerCase();
  const keys = [String(ip), username].map((v,i) => 'manager_attempt:' + i + ':' + crypto.createHash('sha256').update(v).digest('hex'));
  for (const key of keys) { const count = await redis.incr(key); if (count === 1) await redis.expire(key, 900); if (count > 10) throw fail('Слишком много попыток. Повторите через 15 минут.', 429); }
  const m = (await pool.query('SELECT id,web_password_hash,web_auth_version FROM managers WHERE web_login=$1 AND web_enabled=true AND is_active=true', [username])).rows[0];
  const stored = m?.web_password_hash || '00000000000000000000000000000000:' + '0'.repeat(128);
  const candidate = await hash(typeof password === 'string' && password.length <= 128 ? password : '', stored.split(':')[0]);
  if (!m || !crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) throw fail('Неверный логин или пароль.', 401);
  const sid = token(), session = { id: m.id, version: m.web_auth_version, csrf: token() };
  await redis.set('manager_session:' + sid, JSON.stringify(session), 'EX', TTL);
  return sid;
}
async function session(sid) {
  if (!/^[a-f0-9]{64}$/.test(sid || '')) return null;
  const raw = await redis.get('manager_session:' + sid); if (!raw) return null;
  const s = JSON.parse(raw);
  const m = (await pool.query('SELECT id,name,commission_bps,referral_token,is_head_moderator FROM managers WHERE id=$1 AND web_auth_version=$2 AND web_enabled=true AND is_active=true', [s.id, s.version])).rows[0];
  return m ? { ...s, manager: m } : null;
}
// Персональная одноразовая ссылка из Telegram-уведомления модератору: открывает его
// собственную /manager-сессию без пароля и ведёт сразу на карточку одобрения конкретного
// исполнителя. Токен живёт 72ч (модератор может открыть уведомление не сразу) и
// одноразовый — при переходе сразу меняется на обычную сессию (TTL), повторный переход
// по той же ссылке уже не сработает.
const MAGIC_TTL = 72 * 60 * 60;
async function issueMagicLink(managerId, masterId) {
  const t = token();
  await redis.set('manager_magic:' + t, JSON.stringify({ managerId, masterId }), 'EX', MAGIC_TTL);
  return t;
}
async function consumeMagicLink(t) {
  if (!/^[a-f0-9]{64}$/.test(t || '')) return null;
  const key = 'manager_magic:' + t;
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  const { managerId, masterId } = JSON.parse(raw);
  const m = (await pool.query('SELECT id,web_auth_version FROM managers WHERE id=$1 AND web_enabled=true AND is_active=true', [managerId])).rows[0];
  if (!m) return null;
  const sid = token(), session = { id: m.id, version: m.web_auth_version, csrf: token() };
  await redis.set('manager_session:' + sid, JSON.stringify(session), 'EX', TTL);
  return { sid, masterId };
}

// Карточка для быстрого одобрения новой заявки: либо ещё ничья (manager_id IS NULL —
// органическая регистрация), либо уже своя (реферальная — manager_id проставлен при
// регистрации в partner.service.bindNew). Чужую пусть смотрит владелец.
async function reviewGet(managerId, masterId) {
  const master = (await pool.query(
    'SELECT * FROM masters WHERE id=$1', [masterId]
  )).rows[0];
  if (!master) throw fail('Специалист не найден.', 404);
  if (master.manager_id && master.manager_id !== Number(managerId)) throw fail('Заявка уже закреплена за другим менеджером.', 403);
  if (master.is_active && !master.manager_id) throw fail('Активный специалист не закреплён за вами.', 403);
  const categories = await require('./category.service').configForView('ru');
  const { vanSizeSpec } = require('../config/serviceTypes');
  const thresholds = await require('./settings.service').getVanSizeThresholds();
  // Полные пороги (не только текст) — чтобы review.ejs мог на клиенте прикинуть букву
  // по введённым см ещё до отправки формы; итоговую букву всё равно пересчитывает
  // сервер в approvePending, клиентский расчёт — только превью.
  const vanSizes = thresholds.map(t => ({ ...t, spec: vanSizeSpec(t.code, thresholds) }));
  master.services=(await pool.query('SELECT * FROM master_services WHERE master_id=$1',[masterId])).rows;
  return { master, categories, vanSizes };
}

// Свежая проверка из БД (не из закешированной сессии) — на неё завязаны действия с
// реальными последствиями (правка контактов, отклонение заявки), нельзя доверять
// значению из momento сессии, если админ только что снял флаг.
async function requireHeadModerator(managerId) {
  const row = (await pool.query('SELECT is_head_moderator FROM managers WHERE id=$1 AND is_active=true', [managerId])).rows[0];
  if (!row?.is_head_moderator) throw fail('Доступно только главному модератору.', 403);
}

// Правка имени/телефона прямо из карточки одобрения — до сих пор это мог сделать
// только администратор в /admin/masters/:id; типичный случай — опечатка в номере при
// регистрации. Доступно только главному модератору (см. requireHeadModerator) и
// только для ещё не одобренной, не забаненной заявки — после одобрения это уже
// обычное редактирование профиля через /admin, не задача этой карточки.
async function updateContact(managerId, masterId, name, phone) {
  await requireHeadModerator(managerId);
  const { toE164, isGeorgianPhone } = require('../config/phone');
  name = String(name || '').trim().slice(0, 120);
  if (!name) throw fail('Укажите имя.', 400);
  if (!isGeorgianPhone(phone)) throw fail('Укажите номер в формате +995XXXXXXXXX.', 400);
  const master = (await pool.query('SELECT id,is_active,is_banned,manager_id FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master) throw fail('Специалист не найден.', 404);
  if (master.is_active) throw fail('Заявка уже одобрена — правьте контакты в полной карточке в админке.', 409);
  if (master.is_banned) throw fail('Профиль заблокирован.', 409);
  if (master.manager_id && master.manager_id !== Number(managerId)) throw fail('Заявка уже закреплена за другим менеджером.', 403);
  if (!master.manager_id) {
    const claimed = await pool.query('UPDATE masters SET manager_id=$2 WHERE id=$1 AND manager_id IS NULL RETURNING id', [masterId, managerId]);
    if (!claimed.rows[0]) throw fail('Заявку уже забрал другой менеджер.', 409);
  }
  try {
    await pool.query('UPDATE masters SET name=$1, phone=$2 WHERE id=$3', [name, toE164(phone), masterId]);
  } catch (e) {
    if (e.code === '23505') throw fail('Этот номер телефона уже занят другим специалистом.', 409);
    throw e;
  }
  await pool.query("INSERT INTO manager_portal_events(manager_id,master_id,action,body) VALUES($1,$2,'edit_contact',$3)", [managerId, masterId, `Изменены контакты: ${name}, ${toE164(phone)}`]);
}

// Отклонение прямо из карточки одобрения (явный спам/дубль/фейк) — раньше у заявки
// не было третьего исхода кроме «одобрить» или «оставить висеть на модерации
// навсегда»; отдельная блокировка уже существовала в /manager/masters/:id, но только
// ПОСЛЕ того, как заявке назначена категория. Доступно только главному модератору.
async function rejectPending(managerId, masterId, reason) {
  await requireHeadModerator(managerId);
  reason = String(reason || '').trim().slice(0, 500);
  if (!reason) throw fail('Укажите причину отклонения.', 400);
  const master = (await pool.query('SELECT id,is_active,is_banned,manager_id FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master) throw fail('Специалист не найден.', 404);
  if (master.is_active) throw fail('Заявка уже одобрена — для блокировки активного профиля используйте карточку специалиста.', 409);
  if (master.is_banned) throw fail('Уже отклонена.', 409);
  if (master.manager_id && master.manager_id !== Number(managerId)) throw fail('Заявка уже закреплена за другим менеджером.', 403);
  if (!master.manager_id) {
    const claimed = await pool.query('UPDATE masters SET manager_id=$2 WHERE id=$1 AND manager_id IS NULL RETURNING id', [masterId, managerId]);
    if (!claimed.rows[0]) throw fail('Заявку уже забрал другой менеджер.', 409);
  }
  await pool.query('UPDATE masters SET is_banned=true, banned_by_manager_id=$2, banned_reason=$3, banned_at=NOW() WHERE id=$1', [masterId, managerId, reason]);
  await pool.query("INSERT INTO manager_portal_events(manager_id,master_id,action,body) VALUES($1,$2,'reject',$3)", [managerId, masterId, reason]);
}

// Одобрение из быстрой карточки: закрепляет исполнителя за модератором (если ещё
// ничей), проставляет категорию и пробует одобрить. Для van/transport менеджер вводит
// см кузова (длина/ширина/высота) — букву S/M/L/XL/XXL сервер определяет сам через
// deriveVanSize по актуальным порогам (см. settings.service.getVanSizeThresholds),
// а не доверяет тому, что мог посчитать на клиенте JS (см. review.ejs — там только
// превью). Явный vehicleSize остаётся как раньше — 'any' (без ограничения) или прямой
// код, если см не переданы. Для прочих обязательных характеристик, которых тут нет в
// списке полей категории, просим открыть полную карточку в /admin, а не строим тут
// дублирующую форму под все типы услуг (см. category.service — поля per-category).
// Внутреннее ядро, без журналирования события — используется и «только категория»,
// и первым шагом «категория и одобрить», а событие в manager_portal_events у них
// разное (assign_category vs approve), поэтому пишет его каждый вызывающий сам.
async function assignCategoryCore(managerId, masterId, category, attributes = {}, vehicleSize = null, cargoDimensions = null, services = undefined, allowActive = false) {
  const master = (await pool.query('SELECT * FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!master) throw fail('Специалист не найден.', 404);
  if (master.is_banned) throw fail('Профиль заблокирован.', 409);
  if (master.is_active && !allowActive) throw fail('Заявка уже одобрена.', 409);
  if (master.is_active && !master.manager_id) throw fail('Активный специалист не закреплён за вами.', 403);
  if (master.manager_id && master.manager_id !== Number(managerId)) throw fail('Заявка уже закреплена за другим менеджером.', 403);
  if (!master.manager_id) {
    const claimed = await pool.query('UPDATE masters SET manager_id=$2 WHERE id=$1 AND manager_id IS NULL RETURNING id', [masterId, managerId]);
    if (!claimed.rows[0]) throw fail('Заявку уже забрал другой менеджер.', 409);
  }
  let effectiveSize = vehicleSize;
  if ((category === 'van' || services?.some(s=>s.type === 'van')) && cargoDimensions && cargoDimensions.length && cargoDimensions.width && cargoDimensions.height) {
    const { deriveVanSize } = require('../config/serviceTypes');
    const thresholds = await require('./settings.service').getVanSizeThresholds();
    const derived = deriveVanSize(cargoDimensions.length, cargoDimensions.width, cargoDimensions.height, thresholds);
    if (!derived) throw fail('Не удалось определить размер по введённым см — проверьте значения.', 400);
    effectiveSize = derived;
  }
  try {
    await require('./master.service').updateMasterProfile(masterId, {
      name: master.name, phone: master.phone, category,
      vehicleType: master.vehicle_type, vehicleSize: effectiveSize || master.vehicle_size, isFlatbed: master.is_flatbed,
      priceText: master.price_text, description: master.description, serviceAttributes: attributes, services,
    });
  } catch (e) {
    if (e.code === 'INVALID_SERVICE') throw fail('Эта категория требует дополнительных характеристик — заполните их в полной карточке в админке.', 422);
    throw e;
  }
  return master.id;
}

// Две кнопки в review.ejs: «Только категория» (закрепляет заявку и характеристики,
// не одобряя) и «Категория и одобрить» (то же самое + сразу approveMaster) — вместо
// единственного пути, из-за которого приходилось уходить в общий список
// /admin/masters, чтобы отдельно одобрить уже закреплённую заявку.
async function assignCategory(managerId, masterId, category, attributes = {}, vehicleSize = null, cargoDimensions = null, services = undefined) {
  const id = await assignCategoryCore(managerId, masterId, category, attributes, vehicleSize, cargoDimensions, services, true);
  await pool.query("INSERT INTO manager_portal_events(manager_id,master_id,action,body) VALUES($1,$2,'assign_category',$3)", [managerId, masterId, 'Назначены услуги: ' + (services ? services.map(s=>s.type).join(', ') : category)]);
  return id;
}
async function approvePending(managerId, masterId, category, attributes = {}, vehicleSize = null, cargoDimensions = null, services = undefined) {
  await assignCategoryCore(managerId, masterId, category, attributes, vehicleSize, cargoDimensions, services);
  const approved = await require('./master.service').approveMaster(masterId);
  if (!approved) throw fail('Не удалось одобрить — проверьте данные в полной карточке в админке.', 422);
  await pool.query("INSERT INTO manager_portal_events(manager_id,master_id,action,body) VALUES($1,$2,'approve',$3)", [managerId, masterId, 'Одобрены услуги: ' + (services ? services.map(s=>s.type).join(', ') : category)]);
  return approved;
}

async function detail(managerId, masterId) {
  const master = (await pool.query('SELECT id,name,phone,category,balance_tetri,is_active,is_banned,banned_reason,banned_by_manager_id,is_subscribed,subscription_until,created_at FROM masters WHERE id=$1 AND manager_id=$2', [masterId, managerId])).rows[0];
  if (!master) throw fail('Специалист не найден.', 404);
  const ledger = (await pool.query('SELECT b.id,b.amount_tetri,b.reason,b.created_at FROM balance_transactions b JOIN masters m ON m.id=b.master_id WHERE m.id=$1 AND m.manager_id=$2 ORDER BY b.created_at DESC,b.id DESC LIMIT 100', [masterId, managerId])).rows;
  const events = (await pool.query('SELECT e.action,e.body,e.created_at FROM manager_portal_events e JOIN masters m ON m.id=e.master_id WHERE m.id=$1 AND m.manager_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 100', [masterId, managerId])).rows;
  const activity = (await pool.query('SELECT v.order_id,v.event_type,v.viewed_at FROM order_views v JOIN masters m ON m.id=v.master_id WHERE m.id=$1 AND m.manager_id=$2 ORDER BY v.viewed_at DESC LIMIT 100', [masterId, managerId])).rows;
  const since = new Date(Date.now()-30*86400000);
  const contacts = (await pool.query("SELECT * FROM (SELECT v.order_id,MIN(v.viewed_at) AS contacted_at,o.first_dispatched_at FROM order_views v JOIN masters m ON m.id=v.master_id JOIN orders o ON o.id=v.order_id WHERE m.id=$1 AND m.manager_id=$2 AND v.event_type IN ('call','whatsapp') GROUP BY v.order_id,o.first_dispatched_at) contacts WHERE contacted_at >= $3",[masterId,managerId,since])).rows;
  const delays = contacts.filter(c=>c.first_dispatched_at && new Date(c.contacted_at)>=new Date(c.first_dispatched_at)).map(c=>(new Date(c.contacted_at)-new Date(c.first_dispatched_at))/60000);
  const topups = (await pool.query("SELECT COUNT(*) AS count,COALESCE(SUM(b.amount_tetri),0) AS amount FROM balance_transactions b JOIN masters m ON m.id=b.master_id WHERE m.id=$1 AND m.manager_id=$2 AND b.reason='topup' AND b.amount_tetri>0 AND b.created_at >= $3",[masterId,managerId,since])).rows[0];
  return { master, ledger, events, activity, metrics:{contacts:contacts.length,averageMinutes:delays.length?delays.reduce((a,b)=>a+b,0)/delays.length:null,topups} };
}
async function action(managerId, masterId, action, body) {
  body = String(body || '').trim();
  if (!['note','ban','unban'].includes(action) || !body || body.length > 2000) throw fail('Укажите заметку или причину (до 2000 символов).');
  return pool.withTransaction(async tx => {
    const m = (await tx.query('SELECT id,is_banned,banned_by_manager_id FROM masters WHERE id=$1 AND manager_id=$2 FOR UPDATE', [masterId, managerId])).rows[0];
    if (!m) throw fail('Специалист не найден.', 404);
    if (action === 'ban') {
      if (m.is_banned) throw fail('Специалист уже заблокирован.', 409);
      await tx.query('UPDATE masters SET is_banned=true,banned_by_manager_id=$2,banned_reason=$3,banned_at=NOW() WHERE id=$1', [masterId,managerId,body]);
    }
    if (action === 'unban') {
      if (!m.is_banned || m.banned_by_manager_id !== Number(managerId)) throw fail('Можно снять только собственную блокировку.', 403);
      await tx.query('UPDATE masters SET is_banned=false,banned_by_manager_id=NULL,banned_reason=NULL,banned_at=NULL WHERE id=$1', [masterId]);
    }
    await tx.query('INSERT INTO manager_portal_events(manager_id,master_id,action,body) VALUES($1,$2,$3,$4)', [managerId,masterId,action,body]);
  });
}
async function dashboard(id, search = '', page = 1) {
  page = Math.max(1, Math.min(100000, parseInt(page,10) || 1));
  search = String(search).slice(0,100);
  const providers = (await pool.query('SELECT id,name,phone,balance_tetri,is_active,is_banned,is_subscribed,subscription_until FROM business_masters WHERE manager_id=$1 AND (name ILIKE $2 OR phone ILIKE $2) ORDER BY id DESC LIMIT 51 OFFSET $3', [id,'%'+search+'%',(page-1)*50])).rows;
  const stats = (await pool.query('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN is_active=true AND is_banned=false THEN 1 ELSE 0 END),0) AS active,COALESCE(SUM(CASE WHEN is_banned=true THEN 1 ELSE 0 END),0) AS banned,COALESCE(SUM(CASE WHEN balance_tetri<=0 THEN 1 ELSE 0 END),0) AS empty,SUM(balance_tetri) AS balance FROM business_masters WHERE manager_id=$1', [id])).rows[0];
  const orders = (await pool.query('SELECT id,phone,description,status,created_at FROM business_orders WHERE manager_id=$1 ORDER BY created_at DESC LIMIT 100',[id])).rows;
  const funnel = await require('./manager.service').getClientFunnel(id);
  return { providers: providers.slice(0,50), more: providers.length>50, stats, orders, funnel, search, page };
}
async function finances(id, value) {
  const {month,start,end} = require('./partner.service').monthBounds(value);
  const earned = (await pool.query('SELECT COALESCE(SUM(amount_tetri),0) AS amount FROM manager_commissions WHERE manager_id=$1 AND created_at >= $2 AND created_at < $3',[id,start,end])).rows[0].amount;
  const paid = (await pool.query('SELECT COALESCE(SUM(amount_tetri),0) AS amount FROM manager_payouts WHERE manager_id=$1 AND commission_month=$2 AND voided_at IS NULL',[id,month])).rows[0].amount;
  const allEarned = (await pool.query('SELECT COALESCE(SUM(amount_tetri),0) AS amount FROM manager_commissions WHERE manager_id=$1',[id])).rows[0].amount;
  const allPaid = (await pool.query('SELECT COALESCE(SUM(amount_tetri),0) AS amount FROM manager_payouts WHERE manager_id=$1 AND voided_at IS NULL',[id])).rows[0].amount;
  const commissions = (await pool.query('SELECT master_id,base_tetri,rate_bps,amount_tetri,created_at FROM manager_commissions WHERE manager_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 100',[id,start,end])).rows;
  const payouts = (await pool.query('SELECT amount_tetri,paid_at,voided_at FROM manager_payouts WHERE manager_id=$1 AND commission_month=$2 ORDER BY paid_at DESC LIMIT 100',[id,month])).rows;
  return {month,earned,paid,due:Number(earned)-Number(paid),totalDue:Number(allEarned)-Number(allPaid),commissions,payouts};
}
module.exports = { COOKIE,TTL,cookieOptions,token,hash,provision,login,session,detail,action,dashboard,finances,
  issueMagicLink,consumeMagicLink,reviewGet,approvePending,assignCategory,updateContact,rejectPending,
  logout: sid => redis.del('manager_session:'+sid) };


