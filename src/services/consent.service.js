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
  const termsLabel = role === 'client' ? text.clientTerms : `${t('join_terms_label')} ${text.provider}`;
  const privacyLabel = role === 'client' ? text.clientSharing : t('join_privacy_label');
  const notices = [text.platform, role === 'client' ? text.closing : text.providerClosing];
  if (role === 'client') notices.push(text.withdrawal);
  const snapshot = {
    role, language: lang, terms_version: terms.version, privacy_version: privacy.version,
    terms_url: `${base}${prefix}/terms`, privacy_url: `${base}${prefix}/privacy`,
    termsLabel, privacyLabel, notices,
    // Archive actual documents, including the Georgian controlling version and requisites.
    documents: { terms, privacy, requisites: legal.SERVICE_REQUISITES },
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { ...snapshot, digest, text: [...notices, termsLabel, snapshot.terms_url, privacyLabel, snapshot.privacy_url].join('\n') };
}

// opts.requireScroll — исполнитель должен долистать Оферту до конца на отдельном шаге
// /join (см. join.ejs) до того, как кнопка принятия станет активной; сервер не доверяет
// клиенту факт скролла на слово — только булево requireScroll решает, обязателен ли он
// для этой роли/флоу.
async function acceptedRequest(req, role, opts = {}) {
  const current = await bundle(role, req.body.consentLanguage);
  if (req.body.termsAccepted !== true || req.body.privacyAccepted !== true) {
    return { error: copy[current.language].required, status: 400 };
  }
  if (opts.requireScroll && req.body.termsScrolled !== true) {
    return { error: copy[current.language].scrollRequired, status: 400 };
  }
  if (req.body.consentDigest !== current.digest) {
    return { error: copy[current.language].stale, status: 409 };
  }
  // Метка времени — серверная (не из тела запроса): часы клиента доверия не заслуживают.
  return { consent: opts.requireScroll ? { ...current, termsScrolled: true, termsScrolledAt: new Date().toISOString() } : current };
}

module.exports = { bundle, acceptedRequest, copy };
