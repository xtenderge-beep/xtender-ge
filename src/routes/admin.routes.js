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

router.get('/reviews', asyncHandler(adminController.reviewsQueue));
router.post('/reviews/:id/approve', verifyCsrf, asyncHandler(adminController.approveReview));
router.post('/reviews/:id/reject', verifyCsrf, asyncHandler(adminController.rejectReview));

module.exports = router;
