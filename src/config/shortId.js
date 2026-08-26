const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LENGTH = 10;

function generateShortId() {
  const bytes = crypto.randomBytes(LENGTH);
  let id = '';
  for (let i = 0; i < LENGTH; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

module.exports = { generateShortId };
