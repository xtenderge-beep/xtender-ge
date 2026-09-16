const categories=require('../services/category.service');
const settingsService=require('../services/settings.service');
const { vanSizeSpec }=require('../config/serviceTypes');
async function index(req,res) { res.render('admin/categories',{categories:await categories.list()}); }
async function form(req,res) {
 const category=req.params.slug ? await categories.get(req.params.slug) : null;
 if(req.params.slug && !category) return res.status(404).send('Категория не найдена');
 const fieldsLocked=categories.hasLockedField(category?.fields);
 const vanSizeThresholds=fieldsLocked ? await settingsService.getVanSizeThresholds() : null;
 res.render('admin/category-edit',{category,error:req.query.error || null,submitted:null,fieldsLocked,
   vanSizeThresholds,vanSizeSpec,sizeError:req.query.sizeError || null});
}
async function save(req,res) {
 const slug=req.params.slug || null;
 const category=slug ? await categories.get(slug) : null;
 let fields=req.body.fields || [];
 if(!Array.isArray(fields)) fields=[];
 const input={...req.body,is_active:req.body.is_active==='on',fields:fields.map(f=>({...f,required:f.required==='on'}))};
 try { const saved=await categories.save(slug,input);res.redirect('/admin/categories/'+saved.slug); }
 catch(error) {
   if(!error.status)throw error;
   const fieldsLocked=categories.hasLockedField(category?.fields);
   res.status(error.status).render('admin/category-edit',{category,error:error.message,submitted:input,fieldsLocked,
     vanSizeThresholds:fieldsLocked ? await settingsService.getVanSizeThresholds() : null,vanSizeSpec,sizeError:null});
 }
}
async function saveVanSizes(req,res) {
 const category=await categories.get(req.params.slug);
 if(!category || !categories.hasLockedField(category.fields)) return res.status(404).send('Категория не найдена');
 const codes=require('../config/serviceTypes').VAN_SIZE_ORDER;
 const thresholds={};
 for(const code of codes) thresholds[code]={length:req.body['length_'+code],width:req.body['width_'+code],height:req.body['height_'+code]};
 try { await settingsService.setVanSizeThresholds(thresholds); res.redirect('/admin/categories/'+req.params.slug); }
 catch(error) { if(!error.status)throw error; res.redirect('/admin/categories/'+req.params.slug+'?sizeError='+encodeURIComponent(error.message)); }
}
async function remove(req,res) {
 try { await categories.remove(req.params.slug); res.redirect('/admin/categories'); }
 catch(error) { if(!error.status)throw error; res.redirect('/admin/categories/'+req.params.slug+'?error='+encodeURIComponent(error.message)); }
}
async function refreshOrder(req,res) {
 const order=await require('../services/order.service').getOrderByToken(req.params.token);
 if(!order)return res.status(404).send('Заявка не найдена');
 await require('../services/telegram.service').updateMessage(order);
 res.redirect('/admin/orders/'+encodeURIComponent(order.token));
}
module.exports={index,form,save,remove,saveVanSizes,refreshOrder};
