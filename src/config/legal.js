const { translate } = require('./i18n');
const { getBaseUrl } = require('./url');

// Версии юридических документов. Пишутся в sms_consent_logs при подтверждении OTP.
// Поднимать при ЛЮБОМ изменении текста соответствующего документа (legal-content.js).
// Формат: vMAJOR.MINOR-YYYY-MM-DD (дата вступления редакции в силу).
const TERMS_VERSION = 'v1.1-2026-09-03';
const PRIVACY_VERSION = 'v1.0-2026-09-03';

// Реквизиты оператора / юридического лица. ЕДИНСТВЕННОЕ место — страницы /terms и
// /privacy берут отсюда. Заполнить, когда пришлют данные реальной компании; пустые
// поля на странице показываются как «уточняется…» (REQUISITE_PENDING в legal-content.js).
// email и website известны сразу, остальное ждём.
const SERVICE_REQUISITES = {
  entityName: null,    // 'შპს "…"' / 'ООО "…"' / 'LLC "…"'
  idCode: null,        // 9-значный ИНН или 11-значный личный номер
  legalAddress: null,  // 'საქართველო, ქ. თბილისი, …'
  email: 'support@xtender.ge',
  phone: null,         // '+995 5XX XX XX XX'
  website: 'https://xtender.ge',
};

function normBase(baseUrl) {
  return (baseUrl || getBaseUrl()).replace(/\/+$/, '');
}

// Точный текст обоих согласий рядом с кнопкой подтверждения кода — снимаем на сервере
// из словаря (не доверяя клиенту) + абсолютные ссылки на конкретные редакции документов.
// Для флоу без чекбоксов (вход в кабинет, заявка клиента, отзыв) — null.
function consentSnapshot(lang, baseUrl) {
  const t = translate(lang);
  const base = normBase(baseUrl);
  return [
    `[${TERMS_VERSION}] ${t('join_terms_label')} — ${base}/terms`,
    `[${PRIVACY_VERSION}] ${t('join_privacy_label')} — ${base}/privacy`,
  ].join('\n');
}

// Структурированный слепок согласия для metadata JSONB в журнале.
function consentMeta(lang, baseUrl) {
  const base = normBase(baseUrl);
  return {
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    terms_url: `${base}/terms`,
    privacy_url: `${base}/privacy`,
    consent_language: lang,
  };
}

module.exports = {
  TERMS_VERSION,
  PRIVACY_VERSION,
  SERVICE_REQUISITES,
  consentSnapshot,
  consentMeta,
};
