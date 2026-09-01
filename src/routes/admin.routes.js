const express = require('express');
const adminController = require('../controllers/admin.controller');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAdmin, verifyCsrf } = require('../middleware/requireAdmin');

const router = express.Router();

router.get('/login', adminController.showLogin);
router.post('/login', asyncHandler(adminController.login));

router.use(requireAdmin);

router.post('/logout', verifyCsrf, adminController.logout);

router.get('/', asyncHandler(adminController.overview));

router.get('/masters', asyncHandler(adminController.mastersList));
router.get('/masters/:id', asyncHandler(adminController.masterDetail));
router.post('/masters/:id/update', verifyCsrf, asyncHandler(adminController.updateMaster));
router.post('/masters/:id/approve', verifyCsrf, asyncHandler(adminController.approveMaster));
router.post('/masters/:id/ban', verifyCsrf, asyncHandler(adminController.banMaster));
router.post('/masters/:id/unban', verifyCsrf, asyncHandler(adminController.unbanMaster));
router.post('/masters/:id/balance-correction', verifyCsrf, asyncHandler(adminController.correctBalance));

router.get('/orders', asyncHandler(adminController.ordersList));
router.get('/orders/:token', asyncHandler(adminController.orderDetail));
router.post('/orders/:token/close', verifyCsrf, asyncHandler(adminController.closeOrder));

router.get('/reviews', asyncHandler(adminController.reviewsQueue));
router.post('/reviews/:id/approve', verifyCsrf, asyncHandler(adminController.approveReview));
router.post('/reviews/:id/reject', verifyCsrf, asyncHandler(adminController.rejectReview));

router.get('/support', asyncHandler(adminController.supportList));
router.get('/support/:masterId', asyncHandler(adminController.supportThread));
router.post('/support/:masterId/reply', verifyCsrf, asyncHandler(adminController.supportReply));

router.get('/promo', asyncHandler(adminController.promoList));
router.post('/promo', verifyCsrf, asyncHandler(adminController.promoCreate));
router.get('/promo/:code', asyncHandler(adminController.promoDetail));
router.post('/promo/:id/toggle', verifyCsrf, asyncHandler(adminController.promoToggle));

router.get('/managers', asyncHandler(adminController.managersList));
router.post('/managers', verifyCsrf, asyncHandler(adminController.managerCreate));
router.get('/managers/:id', asyncHandler(adminController.managerDetail));
router.post('/managers/:id/update', verifyCsrf, asyncHandler(adminController.managerUpdate));
router.post('/masters/:id/assign-manager', verifyCsrf, asyncHandler(adminController.assignManager));

module.exports = router;
