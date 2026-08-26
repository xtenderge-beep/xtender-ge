const axios = require('axios');
const { toE164 } = require('../config/phone');

const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'http://212.72.155.180:2375/api/sendmsg.php';

function isDevMode() {
  return process.env.NODE_ENV === 'development' || !process.env.SMS_GATEWAY_USERNAME;
}

function normalizePhone(phone) {
  return toE164(phone).slice(1);
}

async function send(phone, text) {
  if (isDevMode()) {
    console.log(`[SMS DEV MODE] to=${phone} text="${text}"`);
    return { success: true, dev: true };
  }

  const response = await axios.get(SMS_GATEWAY_URL, {
    params: {
      username: process.env.SMS_GATEWAY_USERNAME,
      password: process.env.SMS_GATEWAY_PASSWORD,
      num: normalizePhone(phone),
      msg: text,
      utf: 1,
    },
  });

  console.log(`[SMS GATEWAY] to=${normalizePhone(phone)} response=${JSON.stringify(response.data)}`);
  return response.data;
}

function sendOtp(phone, code) {
  return send(phone, `Xtender: ваш код подтверждения ${code}`);
}

function sendOrderNotification(phone, text) {
  return send(phone, text);
}

module.exports = {
  sendOtp,
  sendOrderNotification,
};
