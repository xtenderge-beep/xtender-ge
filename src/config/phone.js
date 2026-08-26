function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const withCountry = digits.length === 9 ? `995${digits}` : digits;
  return `+${withCountry}`;
}

module.exports = { toE164 };
