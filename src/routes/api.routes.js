const express = require('express');
const otpController = require('../controllers/otp.controller');
const orderController = require('../controllers/order.controller');
const masterController = require('../controllers/master.controller');
const reviewController = require('../controllers/review.controller');
const { upload } = require('../config/upload');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/otp/send', asyncHandler(otpController.send));
router.post('/otp/verify', asyncHandler(otpController.verify));

router.post('/orders', upload.array('files', 5), asyncHandler(orderController.create));
router.post('/orders/:token/close', asyncHandler(orderController.close));
router.post('/orders/:token/log-view', asyncHandler(orderController.logView));

router.get('/masters', asyncHandler(masterController.list));
router.post('/masters/otp/send', asyncHandler(masterController.sendOtp));
router.post('/masters/otp/verify', asyncHandler(masterController.verifyOtp));
router.post('/masters/register', asyncHandler(masterController.register));

router.post('/telegram/webhook', asyncHandler(orderController.telegramWebhook));

router.post('/reviews', asyncHandler(reviewController.submit));

module.exports = router;
