const express = require('express');
const otpController = require('../controllers/otp.controller');
const orderController = require('../controllers/order.controller');
const masterController = require('../controllers/master.controller');
const { upload } = require('../config/upload');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/otp/send', asyncHandler(otpController.send));
router.post('/otp/verify', asyncHandler(otpController.verify));

router.post('/orders', upload.array('files', 5), asyncHandler(orderController.create));
router.post('/orders/:token/close', asyncHandler(orderController.close));
router.post('/orders/:token/log-view', asyncHandler(orderController.logView));

router.get('/masters', asyncHandler(masterController.list));

router.post('/telegram/webhook', asyncHandler(orderController.telegramWebhook));

module.exports = router;
