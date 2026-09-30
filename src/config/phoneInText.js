// A phone number written into a provider description bypasses the paid number reveal in the
// catalog. A number here is 9+ digits in a row with at most two spaces, hyphens, dots or brackets
// between them: that catches +995 5XX XX XX XX, (5XX) XX-XX-XX and 0322 XX XX XX, but not body
// sizes like "310 200 40" or years separated by commas. Numbers spelled out in words are not
// caught.
const PHONE = /\+?\d(?:[\s\-.()]{0,2}\d){8,}/g;

function hasPhone(text) {
  return typeof text === 'string' && new RegExp(PHONE.source).test(text);
}

// Display-side safety net for descriptions saved before the check and for their translations.
function maskPhones(text) {
  return typeof text === 'string' ? text.replace(PHONE, '•••') : text;
}

module.exports = { hasPhone, maskPhones };
