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
  const m = (await pool.query('SELECT id,name,commission_bps,referral_token FROM managers WHERE id=$1 AND web_auth_version=$2 AND web_enabled=true AND is_active=true', [s.id, s.version])).rows[0];
  return m ? { ...s, manager: m } : null;
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
module.exports = { COOKIE,TTL,cookieOptions,token,hash,provision,login,session,detail,action,dashboard,finances, logout: sid => redis.del('manager_session:'+sid) };



