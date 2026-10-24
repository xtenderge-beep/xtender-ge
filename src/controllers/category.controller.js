const categories=require('../services/category.service');
const settingsService=require('../services/settings.service');
const requestFields=require('../config/requestFields');
const { vanSizeSpec }=require('../config/serviceTypes');
const masterReturn = value => typeof value === 'string' && /^\/admin\/masters\/[1-9]\d*#admin-services$/.test(value) ? value : null;
async function index(req,res) { res.render('admin/categories',{categories:await categories.list()}); }
// Характеристики исполнителя, с которыми можно сравнивать параметры заявки (включая «Размер кузова»).
function providerFieldOptions(category) {
 return (category?.fields || []).map(f=>[f.key, (f.labels?.ru || f.key) + (f.input==='size' ? ' (S…XXL)' : '')]);
}
// Единицы — только из справочника src/config/units.js; описание и слова поиска — действующие (из базы или прежние из кода).
function formLocals(category, extra) {
 const texts=require('../config/categoryTexts');
 return {category, effectiveRequestFields:requestFields.forCategory(category), providerFieldOptions:providerFieldOptions(category),
   unitOptions:require('../config/units').list('ru'), categoryTexts:{descriptions:texts.descriptions(category || {}), synonyms:texts.synonyms(category || {})}, ...extra};
}
async function form(req,res) {
 const category=req.params.slug ? await categories.get(req.params.slug) : null;
 if(req.params.slug && !category) return res.status(404).send('Категория не найдена');
 const fieldsLocked=categories.hasLockedField(category?.fields);
 const vanSizeThresholds=fieldsLocked ? await settingsService.getVanSizeThresholds() : null;
 res.render('admin/category-edit',formLocals(category,{error:req.query.error || null,submitted:null,fieldsLocked,returnTo:masterReturn(req.query.returnTo),
   vanSizeThresholds,vanSizeSpec,sizeError:req.query.sizeError || null,sizesSaved:/^\d+$/.test(req.query.sizesSaved || '') ? Number(req.query.sizesSaved) : null}));
}
async function save(req,res) {
 const slug=req.params.slug || null;
 const category=slug ? await categories.get(slug) : null;
 let fields=req.body.fields || [];
 if(!Array.isArray(fields)) fields=[];
 // Параметры заявки сохраняются, только если их меняли в форме: иначе действующий список по умолчанию остаётся в коде
 // (src/config/requestFields.js) и обновится вместе с ним.
 let requestInput;
 if(req.body.request_fields_touched==='1') {
   const raw=Array.isArray(req.body.request_fields) ? req.body.request_fields : [];
   requestInput=raw.map(f=>({...f,required:f.required==='on'}));
 }
 const input={...req.body,is_active:req.body.is_active==='on',fields:fields.map(f=>({...f,required:f.required==='on',filter:f.filter==='on'})),request_fields:requestInput};
 try { const saved=await categories.save(slug,input);res.redirect(masterReturn(req.body.returnTo) || '/admin/categories/'+saved.slug); }
 catch(error) {
   if(!error.status)throw error;
   const fieldsLocked=categories.hasLockedField(category?.fields);
   res.status(error.status).render('admin/category-edit',formLocals(category,{error:error.message,submitted:input,fieldsLocked,returnTo:masterReturn(req.body.returnTo),
     vanSizeThresholds:fieldsLocked ? await settingsService.getVanSizeThresholds() : null,vanSizeSpec,sizeError:null,sizesSaved:null}));
 }
}
async function saveVanSizes(req,res) {
 const category=await categories.get(req.params.slug);
 if(!category || !categories.hasLockedField(category.fields)) return res.status(404).send('Категория не найдена');
 const codes=require('../config/serviceTypes').VAN_SIZE_ORDER;
 const thresholds={};
 for(const code of codes) thresholds[code]={length:req.body['length_'+code],width:req.body['width_'+code],height:req.body['height_'+code]};
 // Буквы исполнителей с записанными размерами кузова сразу пересчитываются по новым порогам.
 try { await settingsService.setVanSizeThresholds(thresholds); res.redirect('/admin/categories/'+req.params.slug+'?sizesSaved='+await require('../services/master.service').reclassifyVanSizes()); }
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
