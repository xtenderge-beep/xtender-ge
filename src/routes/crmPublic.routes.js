const router=require('express').Router(),wrap=require('../middleware/asyncHandler');
const crm=require('../services/crm.service'),crypto=require('crypto');
const consent=require('../services/consent.service'),otp=require('../services/otp.service');
router.get('/i/:token',wrap(async(req,res)=>{res.set('Cache-Control','no-store');const item=await crm.open(req.params.token);if(item.kind!=='provider')return res.redirect('/d/'+item.token);res.redirect('/join?ref='+encodeURIComponent(item.referral_token));}));
router.get('/d/:token',wrap(async(req,res)=>{
 res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
 const item=await crm.open(req.params.token);if(item.kind==='provider')return res.redirect('/i/'+item.token);
 const csrf=crypto.randomBytes(32).toString('hex');res.cookie('draft_csrf',csrf,{httpOnly:true,secure:req.secure,sameSite:'lax',maxAge:3600000,path:'/'});
 const lang=['ru','en','ka'].includes(req.cookies.lang)?req.cookies.lang:'ka';
 res.render('crm/draft',{item,csrf,consent:consent.bundle('client',lang),draftLang:lang});
}));
router.post('/api/drafts/:token/send',wrap(async(req,res)=>{
 if(!req.cookies.draft_csrf||req.cookies.draft_csrf!==req.body._csrf)return res.status(403).json({success:false,message:'Обновите страницу / Refresh the page'});
 const item=await crm.publicInvite(req.params.token);if(item.kind==='provider'||item.status!=='unverified')throw crm.fail('Заявка уже отправлена / Request already submitted',409);
 const snapshot=crm.details(req.body),accepted=consent.acceptedRequest(req,'client');if(accepted.error)return res.status(accepted.status).json({success:false,message:accepted.error});
 const order=await require('../services/order.service').getOrderByToken(item.order_token);
 const ownerLink=require('../config/url').getBaseUrl()+'/o/'+order.owner_token;
 const result=await otp.sendCode(item.phone,ownerLink,'order',item.order_id,{meta:require('../config/requestMeta').requestMeta(req),consent:accepted.consent,draftDetails:snapshot});
 if(!result.success)return res.status(result.reason==='rate_limited'?429:503).json({success:false,message:'Не удалось отправить код. Повторите позже / Try again later.'});
 res.json({success:true,token:item.order_token,challengeId:result.challengeId});
}));
router.use((err,req,res,next)=>{if(!err.status)return next(err);res.status(err.status);if(req.path.startsWith('/api/'))return res.json({success:false,message:err.message});res.type('text').send(err.message);});
module.exports=router;
