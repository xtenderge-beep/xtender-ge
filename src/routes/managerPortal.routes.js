const router = require('express').Router();
const service = require('../services/managerPortal.service');
const wrap = require('../middleware/asyncHandler');
router.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
router.get('/login', (req,res) => {
  const csrf = service.token();
  res.cookie('manager_login_csrf',csrf,{...service.cookieOptions,maxAge:900000});
  res.render('manager/login',{csrf,error:null});
});
router.post('/login',wrap(async (req,res) => {
  const csrf = req.cookies.manager_login_csrf;
  if (!csrf || csrf !== req.body._csrf) return res.status(403).send('Обновите страницу входа.');
  try {
    const sid = await service.login(req.body.login,req.body.password,req.ip);
    res.cookie(service.COOKIE,sid,{...service.cookieOptions,maxAge:service.TTL*1000});
    res.clearCookie('manager_login_csrf',service.cookieOptions);
    res.redirect('/manager');
  } catch(e) { if (!e.status) throw e; res.status(e.status).render('manager/login',{csrf,error:e.message}); }
}));
// Ссылка из личного Telegram-уведомления модератору — авторизует его самого без
// пароля и ведёт сразу на карточку одобрения. Должен идти раньше session-guard'а ниже,
// иначе редиректнёт на /login, не успев поставить сессию (см. issueMagicLink/notifyModeratorNewMaster).
router.get('/auth/:token',wrap(async(req,res) => {
  const result = await service.consumeMagicLink(req.params.token);
  if (!result) return res.status(410).render('manager/login',{csrf:service.token(),error:'Ссылка устарела или уже использована. Войдите обычным способом.'});
  res.cookie(service.COOKIE,result.sid,{...service.cookieOptions,maxAge:service.TTL*1000});
  res.redirect('/manager/review/'+encodeURIComponent(result.masterId));
}));
router.use(wrap(async(req,res,next) => {
  req.managerSession = await service.session(req.cookies[service.COOKIE]);
  if (!req.managerSession) return res.redirect('/manager/login');
  res.locals.manager = req.managerSession.manager;
  res.locals.csrf = req.managerSession.csrf;
  res.locals.money = v => (Number(v||0)/100).toFixed(2)+' ₾';
  res.locals.date = v => v ? new Date(v).toLocaleString('ru-RU',{timeZone:'Asia/Tbilisi'}) : '—';
  if (req.method !== 'GET' && req.body._csrf !== req.managerSession.csrf) return res.status(403).send('Обновите страницу и повторите действие.');
  next();
}));
router.post('/logout',wrap(async(req,res) => { await service.logout(req.cookies[service.COOKIE]); res.clearCookie(service.COOKIE,service.cookieOptions);res.redirect('/manager/login'); }));
router.get('/review/:id',wrap(async(req,res) => res.render('manager/review',await service.reviewGet(req.managerSession.id,req.params.id))));
router.post('/review/:id/approve',wrap(async(req,res) => {
  const attributes = Object.fromEntries(Object.entries(req.body).filter(([k]) => k.startsWith('attr_')).map(([k,v]) => [k.slice(5),v]));
  const cargoDimensions = req.body.cargoLength || req.body.cargoWidth || req.body.cargoHeight
    ? { length: req.body.cargoLength, width: req.body.cargoWidth, height: req.body.cargoHeight } : null;
  await service.approvePending(req.managerSession.id,req.params.id,req.body.category,attributes,req.body.vehicleSize,cargoDimensions);
  res.redirect('/manager/masters/'+encodeURIComponent(req.params.id));
}));
const crm=require('../controllers/crm.controller');
router.get('/processes',wrap(crm.show));
router.post('/crm',wrap(crm.create));
router.get('/crm/:id',wrap(crm.card));
router.post('/crm/:id/sent',wrap(crm.sent));
router.post('/crm/:id/note',wrap(crm.note));
router.get('/',wrap(async(req,res) => res.render('manager/dashboard',await service.dashboard(req.managerSession.id,req.query.q,req.query.page))));
router.get('/finances',wrap(async(req,res) => res.render('manager/finances',await service.finances(req.managerSession.id,req.query.month))));
router.get('/masters/:id',wrap(async(req,res) => res.render('manager/detail',await service.detail(req.managerSession.id,req.params.id))));
router.post('/masters/:id/:action',wrap(async(req,res) => { await service.action(req.managerSession.id,req.params.id,req.params.action,req.body.body);res.redirect('/manager/masters/'+encodeURIComponent(req.params.id)); }));
router.use((err,req,res,next) => {
  if (err.status || err.constructor.name === 'PartnerError') return res.status(err.status || 400).render('manager/error',{error:err.message});
  next(err);
});
module.exports=router;
