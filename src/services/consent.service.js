const crypto = require('crypto');
const legal = require('../config/legal');
const documents = require('../config/legal-content');
const copy = require('../config/consent-copy');
const { translate } = require('../config/i18n');

function bundle(role, language) {
  const lang = Object.hasOwn(copy, language) ? language : 'ka';
  const text = copy[lang];
  const t = translate(lang);
  const prefix = lang === 'ka' ? '' : `/${lang}`;
  const base = legal.SERVICE_REQUISITES.website;
  const termsLabel = role === 'client' ? text.clientTerms : `${t('join_terms_label')} ${text.provider}`;
  const privacyLabel = role === 'client' ? text.clientSharing : t('join_privacy_label');
  const notices = [text.platform, role === 'client' ? text.closing : text.providerClosing];
  if (role === 'client') notices.push(text.withdrawal);
  const snapshot = {
    role, language: lang, terms_version: legal.TERMS_VERSION, privacy_version: legal.PRIVACY_VERSION,
    terms_url: `${base}${prefix}/terms`, privacy_url: `${base}${prefix}/privacy`,
    termsLabel, privacyLabel, notices,
    // Archive actual documents, including the Georgian controlling version and requisites.
    documents: { terms: documents.terms, privacy: documents.privacy, requisites: legal.SERVICE_REQUISITES },
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { ...snapshot, digest, text: [...notices, termsLabel, snapshot.terms_url, privacyLabel, snapshot.privacy_url].join('\n') };
}

function acceptedRequest(req, role) {
  const current = bundle(role, req.body.consentLanguage);
  if (req.body.termsAccepted !== true || req.body.privacyAccepted !== true) {
    return { error: copy[current.language].required, status: 400 };
  }
  if (req.body.consentDigest !== current.digest) {
    return { error: copy[current.language].stale, status: 409 };
  }
  return { consent: current };
}

module.exports = { bundle, acceptedRequest, copy };
