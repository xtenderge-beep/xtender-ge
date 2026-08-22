const express = require('express');
const otpController = require('../controllers/otp.controller');
const orderController = require('../controllers/order.controller');
const masterController = require('../controllers/master.controller');
const { upload } = require('../config/upload');

const router = express.Router();

router.post('/otp/send', otpController.send);
router.post('/otp/verify', otpController.verify);

router.post('/orders', upload.array('files', 5), orderController.create);
router.post('/orders/:token/close', orderController.close);
router.post('/orders/:token/log-view', orderController.logView);

router.get('/masters', masterController.list);

module.exports = router;
