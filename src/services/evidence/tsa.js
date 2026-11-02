const crypto = require('crypto');
const axios = require('axios');

// Независимая метка времени по RFC 3161: служба (DigiCert, FreeTSA) подписывает отпечаток SHA-256 и время своим
// ключом. Ответ хранится целиком; проверить его может кто угодно без нас: openssl ts -verify (см. README архива).
// Здесь — только запрос и разбор ответа: статус, наш ли отпечаток, наш ли nonce, время службы. Подпись службы
// здесь не проверяется, это делает openssl у проверяющего.
const DEFAULT_URLS = ['http://timestamp.digicert.com', 'https://freetsa.org/tsr'];
const SHA256_OID = Buffer.from('0609608648016503040201', 'hex');

function urls() {
  return (process.env.TSA_URLS || DEFAULT_URLS.join(',')).split(',').map((value) => value.trim()).filter(Boolean);
}

function der(tag, content) {
  const length = content.length;
  const head = length < 0x80 ? Buffer.from([tag, length])
    : length < 0x100 ? Buffer.from([tag, 0x81, length]) : Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([head, content]);
}

function derInteger(bytes) {
  const value = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return der(0x02, value);
}

// TimeStampReq { version 1, messageImprint { sha256, hash }, nonce, certReq TRUE }
function request(hashHex, nonce) {
  const algorithm = der(0x30, Buffer.concat([SHA256_OID, Buffer.from([0x05, 0x00])]));
  const imprint = der(0x30, Buffer.concat([algorithm, der(0x04, Buffer.from(hashHex, 'hex'))]));
  return der(0x30, Buffer.concat([derInteger(Buffer.from([1])), imprint, derInteger(nonce), Buffer.from([0x01, 0x01, 0xff])]));
}

function readTlv(buffer, offset) {
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < bytes; i += 1) length = length * 256 + buffer[start + i];
    start += bytes;
  }
  return { tag, start, end: start + length };
}

// TimeStampResp { status PKIStatusInfo { status INTEGER, ... }, timeStampToken }. 0 и 1 — выдано.
function parse(response, hashHex, nonce) {
  const outer = readTlv(response, 0);
  // Ответ должен прийти целиком: длина внешней структуры совпадает с длиной тела. Обрезанный ответ openssl не прочтёт.
  if (outer.tag !== 0x30 || outer.end !== response.length) return { granted: false, status: null, imprintMatches: false, nonceMatches: false, genTime: null, tokenBytes: 0, incomplete: true };
  const statusInfo = readTlv(response, outer.start);
  const statusInt = readTlv(response, statusInfo.start);
  const status = response[statusInt.end - 1];
  const hash = Buffer.from(hashHex, 'hex');
  const tokenStart = statusInfo.end;
  const token = response.subarray(tokenStart, outer.end);
  // Время службы — GeneralizedTime (тег 0x18) в TSTInfo, первое такое поле после отпечатка.
  let genTime = null;
  const at = token.indexOf(hash);
  for (let i = at > 0 ? at + hash.length : 0; i < token.length - 2; i += 1) {
    if (token[i] === 0x18 && token[i + 1] >= 15 && token[i + 1] <= 24) {
      const text = token.subarray(i + 2, i + 2 + token[i + 1]).toString('latin1');
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(text);
      if (match) { genTime = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] || ''}Z`); break; }
    }
  }
  return { granted: status === 0 || status === 1, status, imprintMatches: at > 0, nonceMatches: token.indexOf(nonce) > 0, genTime, tokenBytes: token.length };
}

// Поставить метку на отпечаток. Возвращает ответ службы целиком (base64) и разбор; при сбое всех служб — null.
async function stamp(hashHex) {
  for (const url of urls()) {
    const nonce = crypto.randomBytes(8);
    nonce[0] &= 0x7f;
    try {
      const response = await axios.post(url, request(hashHex, nonce), {
        headers: { 'Content-Type': 'application/timestamp-query' }, responseType: 'arraybuffer', timeout: 15000,
      });
      const body = Buffer.from(response.data);
      const result = parse(body, hashHex, nonce);
      if (result.granted && result.imprintMatches && result.nonceMatches) return { url, response: body.toString('base64'), ...result };
      console.error(`[tsa] ${url}: ответ не подходит`, JSON.stringify({ status: result.status, imprint: result.imprintMatches, nonce: result.nonceMatches }));
    } catch (error) {
      console.error(`[tsa] ${url}: ${error.message}`);
    }
  }
  return null;
}

module.exports = { stamp, request, parse, urls };
