const axios = require('axios');

const SMS_API_URL = 'https://api.smsoffice.ge/v2/send/';

function isDevMode() {
  return process.env.NODE_ENV === 'development' || !process.env.SMS_API_KEY;
}

async function send(phone, text) {
  if (isDevMode()) {
    console.log(`[SMS DEV MODE] to=${phone} text="${text}"`);
    return { success: true, dev: true };
  }

  const response = await axios.post(SMS_API_URL, {
    apikey: process.env.SMS_API_KEY,
    destination: phone,
    sender: process.env.SMS_SENDER_ID,
    content: text,
  });

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
