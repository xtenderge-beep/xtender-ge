const settings = require('./settings.service');
const legalContent = require('../config/legal-content');
const { parseDocBody, renderDocBody } = require('../config/legalTextFormat');

// Оферта/Политика, editable from /admin/legal without a deploy. Same key/value pattern
// as lead_price_tetri (settings.service.js) and payment_details (topup.service.js):
// app_settings row per document, no in-memory cache — an extra SELECT per render is
// cheap and, per that same file's own reasoning, simpler than risking a stale cache
// after an admin edit (which would also silently break the digest-lock WYSIWYG guarantee
// in consent.service.js — every caller here must see the current row, always).
const TERMS_KEY = 'legal_terms';
const PRIVACY_KEY = 'legal_privacy';

const INTL_LOCALE = { ka: 'ka-GE', ru: 'ru-RU', en: 'en-US' };
function formatUpdated(date) {
  const out = {};
  for (const lang of ['ka', 'ru', 'en']) {
    out[lang] = new Intl.DateTimeFormat(INTL_LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
  return out;
}

// vMAJOR.MINOR-YYYY-MM-DD — every save bumps MINOR and today's date; MAJOR is manual
// (reserved for a hypothetical restructure, not a content edit). See legal.js history.
function bumpVersion(current) {
  const m = /^v(\d+)\.(\d+)-/.exec(String(current || ''));
  const major = m ? m[1] : '1';
  const minor = m ? parseInt(m[2], 10) + 1 : 1;
  const today = new Date().toISOString().slice(0, 10);
  return `v${major}.${minor}-${today}`;
}

async function readDoc(key, fallback) {
  const raw = await settings.getSetting(key, null);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.body && parsed.body.ka && parsed.body.ru && parsed.body.en) return parsed;
  } catch { /* corrupted row — fall back rather than break every page that renders this */ }
  return fallback;
}

// Fallback = legal-content.js's already-resolved export (its own post-processing, which
// splices in consentDetails/consentCopy, already ran at require() time) — so until an
// admin explicitly saves an edit, the site keeps showing today's exact text unchanged.
async function getTerms() {
  return readDoc(TERMS_KEY, legalContent.terms);
}
async function getPrivacy() {
  return readDoc(PRIVACY_KEY, legalContent.privacy);
}

async function saveDoc(key, current, texts) {
  const body = {};
  for (const lang of ['ka', 'ru', 'en']) {
    const blocks = parseDocBody(texts && texts[lang]);
    if (!blocks.length) {
      const err = new Error(`Текст документа (${lang}) не может быть пустым`);
      err.status = 400;
      throw err;
    }
    body[lang] = blocks;
  }
  const doc = { version: bumpVersion(current.version), updated: formatUpdated(new Date()), body };
  await settings.setSetting(key, JSON.stringify(doc));
  return doc;
}

async function saveTerms(texts) {
  return saveDoc(TERMS_KEY, await getTerms(), texts);
}
async function savePrivacy(texts) {
  return saveDoc(PRIVACY_KEY, await getPrivacy(), texts);
}

module.exports = { getTerms, getPrivacy, saveTerms, savePrivacy, renderDocBody };
