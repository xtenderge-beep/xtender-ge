const otpService = require('../services/otp.service');

const PHONE_REGEX = /^\+?\d{9,15}$/;

async function send(req, res) {
  const { phone } = req.body;

  if (!phone || !PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const result = await otpService.sendCode(phone);

  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests, try again later' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }

  return res.json({ success: true, message: 'Code sent' });
}

async function verify(req, res) {
  const { phone, code } = req.body;

  if (!phone || !PHONE_REGEX.test(phone) || !code) {
    return res.status(400).json({ success: false, message: 'Invalid phone or code' });
  }

  const isValid = await otpService.verifyCode(phone, code);

  if (!isValid) {
    return res.status(400).json({ success: false, message: 'Invalid or expired code' });
  }

  return res.json({ success: true, message: 'Verified' });
}

module.exports = {
  send,
  verify,
};
