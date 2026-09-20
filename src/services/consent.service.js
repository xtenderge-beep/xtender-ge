const crypto = require('crypto');
const legal = require('../config/legal');
const legalContentService = require('./legalContent.service');
const copy = require('../config/consent-copy');
const { translate } = require('../config/i18n');

// async: terms/privacy now come from legalContent.service (DB-backed, admin-editable at
// /admin/legal), not a static require() — every call re-reads the current document so the
// digest below is always computed from what's live *right now*, same guarantee as before.
async function bundle(role, language) {
  const lang = Object.hasOwn(copy, language) ? language : 'ka';
  const text = copy[lang];
  const t = translate(lang);
  const prefix = lang === 'ka' ? '' : `/${lang}`;
  const base = legal.SERVICE_REQUISITES.website;
  const [terms, privacy] = await Promise.all([legalContentService.getTerms(), legalContentService.getPrivacy()]);
  const termsLabel = role === 'client' ? text.clientTerms : `${t('signup_terms')} ${t('signup_sms')}`;
  const privacyLabel = role === 'client' ? text.clientSharing : t('signup_privacy');
  const notices = role === 'client' ? [text.platform, text.closing] : t('signup_summary');
  if (role === 'client') notices.push(text.withdrawal);
  const snapshot = {
    role, language: lang, terms_version: terms.version, privacy_version: privacy.version,
    terms_url: `${base}${prefix}/terms`, privacy_url: `${base}${prefix}/privacy`,
    termsLabel, privacyLabel, notices,
    ...(role === 'provider' ? { confirmationHint: t('signup_next_hint'), acceptance_method: 'explicit_checkboxes_and_sms' } : {}),
    // Archive actual documents, including the Georgian controlling version and requisites.
    documents: { terms, privacy, requisites: legal.SERVICE_REQUISITES },
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { ...snapshot, digest, text: [...notices, termsLabel, snapshot.terms_url, privacyLabel, snapshot.privacy_url].join('\n') };
}

async function acceptedRequest(req, role) {
  const current = await bundle(role, req.body.consentLanguage);
  if (req.body.termsAccepted !== true || req.body.privacyAccepted !== true) {
    const message = role === 'provider' ? translate(current.language)(req.body.termsAccepted !== true ? 'signup_terms_required' : 'signup_privacy_required') : copy[current.language].required;
    return { error: message, status: 400 };
  }
  if (req.body.consentDigest !== current.digest) {
    return { error: copy[current.language].stale, status: 409 };
  }
  return { consent: current };
}

module.exports = { bundle, acceptedRequest, copy };
