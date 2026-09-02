const otpService = require('../services/otp.service');
const orderService = require('../services/order.service');
const { getBaseUrl } = require('../config/url');
const { requestMeta } = require('../config/requestMeta');
const { TERMS_VERSION } = require('../config/legal');

const PHONE_REGEX = /^\+?\d{9,15}$/;

async function send(req, res) {
  const { description, districtName } = req.body;
  const phone = (req.body.phone || '').replace(/\s+/g, '');

  if (!phone || !PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ success: false, message: 'Description is required' });
  }

  const order = await orderService.createPendingOrder({
    phone,
    description,
    districtName: districtName || '',
  });

  const link = `${getBaseUrl()}/o/${order.owner_token}`;
  const result = await otpService.sendCode(phone, link, 'order', order.id, { meta: requestMeta(req) });

  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests, try again later' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }

  return res.json({ success: true, message: 'Code sent', token: order.token });
}

async function verify(req, res) {
  const { code } = req.body;
  const phone = (req.body.phone || '').replace(/\s+/g, '');

  if (!phone || !PHONE_REGEX.test(phone) || !code) {
    return res.status(400).json({ success: false, message: 'Invalid phone or code' });
  }

  const isValid = await otpService.verifyCode(phone, code, 'order', {
    meta: requestMeta(req),
    language: req.lang,
    termsVersion: TERMS_VERSION,
  });

  if (!isValid) {
    return res.status(400).json({ success: false, message: 'Invalid or expired code' });
  }

  return res.json({ success: true, message: 'Verified' });
}

module.exports = {
  send,
  verify,
};
