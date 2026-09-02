const axios = require('axios');
const { toE164 } = require('../config/phone');
const consentLog = require('./consentLog.service');

const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'http://212.72.155.180:2375/api/sendmsg.php';

function isDevMode() {
  return process.env.NODE_ENV === 'development' || !process.env.SMS_GATEWAY_USERNAME;
}

function normalizePhone(phone) {
  return toE164(phone).slice(1);
}

// Формат ответа шлюза (sendmsg.php) не документирован — видели и число, и "OK: <id>",
// и JSON. Тянем ID сообщения/транзакции best-effort; сырой ответ всё равно сохраняется
// в provider_response, так что при запросе оператора связи есть на что сослаться.
function extractMessageId(data) {
  if (data == null) return null;
  if (typeof data === 'number') return String(data);
  if (typeof data === 'object') {
    const id = data.id || data.message_id || data.messageId || data.msgid || data.smsid || data.sms_id;
    return id ? String(id) : null;
  }
  const s = String(data).trim();
  const tagged = s.match(/(?:id|msgid|message[_-]?id)\D*(\d{3,})/i);
  if (tagged) return tagged[1];
  const bareNum = s.match(/\b(\d{6,})\b/);
  if (bareNum) return bareNum[1];
  return s && s.length <= 64 ? s : null;
}

// context:
//   { kind }              — 'lead' | 'transactional' (по умолчанию 'transactional')
//   { purpose }           — otp purpose, если применимо
//   { masterId, orderId } — связи для журнала
//   { meta }              — { ip, userAgent, xForwardedFor } из requestMeta(req)
//   { log: false }        — не писать строку доставки здесь (OTP-отправки логирует otp.service)
async function send(phone, text, context = {}) {
  const e164 = toE164(phone);
  let providerMessageId = null;
  let providerResponse = null;
  let ok = false;

  try {
    if (isDevMode()) {
      console.log(`[SMS DEV MODE] to=${phone} text="${text}"`);
      providerResponse = { dev: true };
      ok = true;
    } else {
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
      providerResponse = response.data;
      providerMessageId = extractMessageId(response.data);
      ok = true;
    }
  } catch (err) {
    providerResponse = { error: err.message };
    console.error(`[SMS GATEWAY] to=${normalizePhone(phone)} failed: ${err.message}`);
    if (context.log !== false) {
      consentLog.recordSmsDelivery({
        phone: e164, kind: context.kind, purpose: context.purpose || null, body: text,
        masterId: context.masterId || null, orderId: context.orderId || null,
        providerMessageId, providerResponse, meta: context.meta || {},
      }).catch(() => {});
    }
    throw err; // прежнее поведение: ошибка отправки всплывает наверх
  }

  if (context.log !== false) {
    // best-effort — журнал доставки не должен ронять отправку SMS
    consentLog.recordSmsDelivery({
      phone: e164, kind: context.kind, purpose: context.purpose || null, body: text,
      masterId: context.masterId || null, orderId: context.orderId || null,
      providerMessageId, providerResponse, meta: context.meta || {},
    }).catch(() => {});
  }

  return { ok, providerMessageId, providerResponse };
}

// Код авторизации. `log: false` — строку журнала пишет otp.service (там есть код для
// хэша, purpose и метаданные запроса).
function sendOtp(phone, code, context = {}) {
  return send(phone, `Code: ${code}`, { ...context, log: false });
}

function sendOrderNotification(phone, text, context = {}) {
  return send(phone, text, context);
}

module.exports = {
  sendOtp,
  sendOrderNotification,
};
