const axios = require('axios');
const { toE164, isGeorgianPhone } = require('../config/phone');
const consentLog = require('./consentLog.service');

const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'http://212.72.155.180:2375/api/sendmsg.php';

function isDevMode() {
  return process.env.NODE_ENV === 'development' || (process.env.NODE_ENV !== 'production' && !process.env.SMS_GATEWAY_USERNAME);
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

// Fail closed on errors and undocumented replies. HTTP 200 alone is not an
// acceptance receipt. This is gateway acceptance, never handset delivery.
function acceptedResponse(data) {
  if (typeof data === 'string') {
    const value = data.trim();
    if (value.startsWith('{')) {
      try { return acceptedResponse(JSON.parse(value)); } catch (_) { return false; }
    }
    return /^OK(?:\s*:\s*|\s+)[1-9]\d*$/i.test(value) || /^[1-9]\d{5,}$/.test(value);
  }
  if (typeof data === 'number') return Number.isSafeInteger(data) && data >= 100000;
  if (!data || typeof data !== 'object' || data.error || data.ok === false || data.success === false) return false;
  const status = String(data.status || '').toLowerCase();
  if (status && !['ok', 'accepted', 'queued', 'success'].includes(status)) return false;
  const id = data.id || data.message_id || data.messageId || data.msgid || data.smsid || data.sms_id;
  return Boolean(id && (data.ok === true || data.success === true || status));
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
      if (!process.env.SMS_GATEWAY_USERNAME || !process.env.SMS_GATEWAY_PASSWORD) throw new Error('SMS gateway credentials are not configured');
      const response = await axios.get(SMS_GATEWAY_URL, {
        timeout: 15000,
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
      if (!acceptedResponse(providerResponse)) {
        const error = new Error('SMS gateway did not confirm acceptance');
        error.code = 'SMS_NOT_ACCEPTED';
        throw error;
      }
      providerMessageId = extractMessageId(response.data);
      ok = true;
    }
  } catch (err) {
    providerResponse = providerResponse ?? { error: err.message };
    console.error(`[SMS GATEWAY] to=${normalizePhone(phone)} failed: ${err.message}`);
    if (context.log !== false) {
      consentLog.recordSmsDelivery({
        phone: e164, kind: context.kind, purpose: context.purpose || null, body: text,
        masterId: context.masterId || null, orderId: context.orderId || null,
        providerMessageId, providerResponse, meta: context.meta || {}, status: 'failed',
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

  return { ok, status: 'accepted', providerMessageId, providerResponse, messageBody: text };
}

// Код авторизации. `log: false` — строку журнала пишет otp.service (там есть код для
// хэша, purpose и метаданные запроса).
function sendOtp(phone, code, context = {}) {
  if (!isGeorgianPhone(phone)) throw new Error('OTP is available only for Georgian numbers (+995 and 9 digits)');
  return send(phone, require('../config/service-message-copy')('code', context.language || 'en', { code }), { ...context, log: false });
}

function sendOrderNotification(phone, text, context = {}) {
  return send(phone, text, context);
}

module.exports = {
  acceptedResponse,
  sendOtp,
  sendOrderNotification,
};
