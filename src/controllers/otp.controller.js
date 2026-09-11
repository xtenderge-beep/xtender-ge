const consentService = require('../services/consent.service');
const otpService = require('../services/otp.service');
const orderService = require('../services/order.service');
const managerService = require('../services/manager.service');
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

  const acceptance = consentService.acceptedRequest(req, 'client');
  if (acceptance.error) return res.status(acceptance.status).json({ success: false, message: acceptance.error });

  // Пришёл по ссылке менеджера — привязываем заявку к нему.
  let managerId = null;
  let inviteToken = null;
  const cookieInvite = req.cookies && req.cookies.order_invite;
  if (cookieInvite) {
    const invite = await managerService.getClientInvite(cookieInvite);
    if (invite) {
      managerId = invite.manager_id;
      inviteToken = invite.token;
    }
  }

  const order = await orderService.createPendingOrder({
    phone,
    description,
    districtName: districtName || '',
    managerId,
  });
  if (inviteToken) {
    managerService.linkInviteToOrder(inviteToken, order.id).catch(() => {});
  }

  const link = `${getBaseUrl()}/o/${order.owner_token}`;
  const result = await otpService.sendCode(phone, link, 'order', order.id, { meta: requestMeta(req), consent: acceptance.consent });

  if (!result.success) {
    if (result.reason === 'rate_limited') {
      return res.status(429).json({ success: false, message: 'Too many requests, try again later' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code' });
  }

  return res.json({ success: true, message: 'Code sent', token: order.token, challengeId: result.challengeId });
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
    challengeId: req.body.challengeId, strict: true,
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
