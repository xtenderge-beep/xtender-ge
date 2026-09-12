const crypto = require('crypto');
const partner = require('../services/partner.service');
const { getBaseUrl } = require('../config/url');
function id(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new partner.PartnerError('Некорректный ID.');
  return Number(value);
}
function failure(res, error, back) {
  if (!(error instanceof partner.PartnerError)) throw error;
  return res.status(400).render('admin/partner-error', { message: error.message, back });
}
async function show(req,res) {
  res.set('Cache-Control','no-store');
  try {
    const report=await partner.report(req.query.month);
    const selected=req.query.manager ? id(req.query.manager) : null;
    const detail=selected ? report.rows.find(m=>m.id===selected) : null;
    if(selected && !detail) return res.status(404).send('Менеджер не найден.');
    res.render('admin/partner-payouts',{report,detail,requestKey:crypto.randomUUID(),baseUrl:getBaseUrl()});
  } catch(error) { return failure(res,error,'/admin/partner-payouts'); }
}
async function createLink(req,res) {
  try { const managerId=id(req.params.id);await partner.createLink(managerId);res.redirect('/admin/managers/'+managerId); }
  catch(error) { return failure(res,error,'/admin/managers'); }
}
async function setRate(req,res) {
  try { const managerId=id(req.params.id);await partner.setRate(managerId,req.body.percent);res.redirect('/admin/managers/'+managerId); }
  catch(error) { return failure(res,error,'/admin/managers'); }
}
async function bind(req,res) {
  try { const managerId=id(req.params.id);await partner.bindExisting(managerId,id(req.body.masterId),req.body.note);res.redirect('/admin/partner-payouts?manager='+managerId); }
  catch(error) { return failure(res,error,'/admin/managers'); }
}
async function pay(req,res) {
  try { const managerId=id(req.params.id);await partner.recordPayment(managerId,req.body.month,req.body.amount,req.body.reference,req.body.requestKey);
    res.redirect('/admin/partner-payouts?manager='+managerId+'&month='+encodeURIComponent(req.body.month)); }
  catch(error) { return failure(res,error,'/admin/partner-payouts'); }
}
async function voidPayment(req,res) {
  try { const managerId=id(req.params.id);await partner.voidPayment(managerId,id(req.params.paymentId),req.body.reason);res.redirect('/admin/partner-payouts?manager='+managerId+'&month='+encodeURIComponent(req.body.month || '')); }
  catch(error) { return failure(res,error,'/admin/partner-payouts'); }
}
module.exports={show,createLink,setRate,bind,pay,voidPayment};
