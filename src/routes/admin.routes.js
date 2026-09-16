const express = require('express');
const multer = require('multer');
const adminController = require('../controllers/admin.controller');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAdmin, verifyCsrf } = require('../middleware/requireAdmin');

const router = express.Router();

// Bank statements carry account numbers and counterparties — memory storage only
// (never written to public/uploads, unlike src/config/upload.js's receipt images),
// parsed once per request and discarded.
const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname || '') || file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
});

router.get('/login', adminController.showLogin);
router.post('/login', asyncHandler(adminController.login));
router.post('/verify-2fa', asyncHandler(adminController.verify2fa));
router.post('/verify-2fa/resend', asyncHandler(adminController.resend2fa));

router.use(requireAdmin);
const categories = require('../controllers/category.controller');
router.get('/categories', asyncHandler(categories.index));
router.get('/categories/new', asyncHandler(categories.form));
router.get('/categories/:slug', asyncHandler(categories.form));
router.post('/categories', verifyCsrf, asyncHandler(categories.save));
router.post('/categories/:slug', verifyCsrf, asyncHandler(categories.save));
router.post('/orders/:token/refresh-categories', verifyCsrf, asyncHandler(categories.refreshOrder));
const crm=require('../controllers/crm.controller');
router.get('/processes',asyncHandler(crm.show));
router.post('/crm',verifyCsrf,asyncHandler(crm.create));
router.get('/crm/:id',asyncHandler(crm.card));
router.post('/crm/:id/sent',verifyCsrf,asyncHandler(crm.sent));
router.post('/crm/:id/note',verifyCsrf,asyncHandler(crm.note));
router.post('/managers/:id/plan',verifyCsrf,asyncHandler(crm.plan));

router.post('/logout', verifyCsrf, adminController.logout);

router.get('/', asyncHandler(adminController.overview));

router.get('/masters', asyncHandler(adminController.mastersList));
router.get('/masters/:id', asyncHandler(adminController.masterDetail));
router.post('/masters/:id/update', verifyCsrf, asyncHandler(adminController.updateMaster));
router.post('/masters/:id/approve', verifyCsrf, asyncHandler(adminController.approveMaster));
router.post('/masters/:id/ban', verifyCsrf, asyncHandler(adminController.banMaster));
router.post('/masters/:id/unban', verifyCsrf, asyncHandler(adminController.unbanMaster));
router.post('/masters/:id/delete', verifyCsrf, asyncHandler(adminController.deleteMaster));
router.post('/masters/:id/balance-correction', verifyCsrf, asyncHandler(adminController.correctBalance));

router.get('/receipts', asyncHandler(adminController.receiptsList));
router.post('/receipts/:id/review', verifyCsrf, asyncHandler(adminController.receiptReview));
router.post('/receipts/:id/confirm', verifyCsrf, asyncHandler(adminController.confirmTopup));
router.post('/receipts/:id/cancel', verifyCsrf, asyncHandler(adminController.cancelTopup));
router.post('/receipts/import-statement', statementUpload.single('statement'), verifyCsrf, asyncHandler(adminController.importStatement));
router.post('/receipts/assign-statement-credit', verifyCsrf, asyncHandler(adminController.assignStatementCredit));
router.post('/receipts/dismiss-statement-credit', verifyCsrf, asyncHandler(adminController.dismissStatementCredit));

router.get('/orders', asyncHandler(adminController.ordersList));
router.get('/orders/:token/dispatch', asyncHandler(adminController.dispatchPreview));
router.post('/orders/:token/dispatch', verifyCsrf, asyncHandler(adminController.dispatchOrder));
router.get('/orders/:token', asyncHandler(adminController.orderDetail));
router.post('/orders/:token/request-revision', verifyCsrf, asyncHandler(adminController.requestOrderRevision));
router.post('/orders/:token/close', verifyCsrf, asyncHandler(adminController.closeOrder));
router.post('/orders/:token/delete', verifyCsrf, asyncHandler(adminController.deleteOrder));

router.get('/reviews', asyncHandler(adminController.reviewsQueue));
router.post('/reviews/:id/approve', verifyCsrf, asyncHandler(adminController.approveReview));
router.post('/reviews/:id/reject', verifyCsrf, asyncHandler(adminController.rejectReview));

router.get('/consent', asyncHandler(adminController.consentLog));
router.get('/consent/export', asyncHandler(adminController.consentExport));

router.get('/support', asyncHandler(adminController.supportList));
router.get('/support/:masterId', asyncHandler(adminController.supportThread));
router.post('/support/:masterId/reply', verifyCsrf, asyncHandler(adminController.supportReply));

router.get('/promo', asyncHandler(adminController.promoList));
router.post('/promo', verifyCsrf, asyncHandler(adminController.promoCreate));
router.get('/promo/:code', asyncHandler(adminController.promoDetail));
router.post('/promo/:id/toggle', verifyCsrf, asyncHandler(adminController.promoToggle));

router.get('/partner-payouts', asyncHandler(require('../controllers/partner.controller').show));
router.post('/managers/:id/partner-link', verifyCsrf, asyncHandler(require('../controllers/partner.controller').createLink));
router.post('/managers/:id/partner-rate', verifyCsrf, asyncHandler(require('../controllers/partner.controller').setRate));
router.post('/managers/:id/partner-bind', verifyCsrf, asyncHandler(require('../controllers/partner.controller').bind));
router.post('/managers/:id/partner-payment', verifyCsrf, asyncHandler(require('../controllers/partner.controller').pay));
router.post('/managers/:id/partner-payment/:paymentId/void', verifyCsrf, asyncHandler(require('../controllers/partner.controller').voidPayment));
router.get('/managers', asyncHandler(adminController.managersList));
router.post('/managers/:id/web-access', verifyCsrf, asyncHandler(async (req,res) => {
  try {
    await require('../services/managerPortal.service').provision(req.params.id,req.body.login,req.body.password,req.body.enabled === 'on');
    res.redirect('/admin/managers/'+encodeURIComponent(req.params.id));
  } catch(e) { if (!e.status) throw e; res.status(e.status).render('manager/error',{error:e.message}); }
}));
router.post('/managers', verifyCsrf, asyncHandler(adminController.managerCreate));
router.get('/managers/:id', asyncHandler(adminController.managerDetail));
router.post('/managers/:id/update', verifyCsrf, asyncHandler(adminController.managerUpdate));
router.post('/managers/:id/client-link', verifyCsrf, asyncHandler(adminController.managerClientLink));
router.post('/masters/:id/assign-manager', verifyCsrf, asyncHandler(adminController.assignManager));

router.post('/settings/welcome-bonus', verifyCsrf, asyncHandler(adminController.updateWelcomeBonus));
router.post('/settings/payment-details', verifyCsrf, asyncHandler(adminController.updatePaymentDetails));
const technicalController = require('../controllers/technical.controller');
router.get('/settings/technical', asyncHandler(technicalController.show));
router.post('/settings/technical', verifyCsrf, asyncHandler(technicalController.update));
router.get('/settings', asyncHandler(adminController.settingsPage));
router.post('/settings/lead-price', verifyCsrf, asyncHandler(adminController.updateLeadPrice));
router.post('/settings/catalog-call-price', verifyCsrf, asyncHandler(adminController.updateCatalogCallPrice));

module.exports = router;
