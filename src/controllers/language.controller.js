const { normalizeLang } = require('../config/i18n');

// Only local paths are valid redirect targets, including when Referer is absent.
function returnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://xtender.invalid');
    if (url.origin !== 'https://xtender.invalid' || url.pathname.startsWith('/lang/')) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

function change(req, res) {
  const lang = normalizeLang(req.params.code);
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.set('Cache-Control', 'no-store');
  res.redirect(returnPath(req.query.next));
}

module.exports = { change, returnPath };
