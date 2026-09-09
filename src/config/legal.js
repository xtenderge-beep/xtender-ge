const { translate } = require('./i18n');
const { getBaseUrl } = require('./url');

// Версии юридических документов. Пишутся в sms_consent_logs при подтверждении OTP.
// Поднимать при ЛЮБОМ изменении текста соответствующего ДОКУМЕНТА (legal-content.js).
// Текст чекбоксов на /join (i18n join_terms_label/join_privacy_label) при этом
// НЕ версионируется здесь — он сохраняется дословно в consent_text_snapshot на каждую
// регистрацию, так что мелкие правки формулировок отслеживаются сами.
// Формат: vMAJOR.MINOR-YYYY-MM-DD (дата вступления редакции в силу).
const TERMS_VERSION = 'v1.5-2026-09-09';
const PRIVACY_VERSION = 'v1.4-2026-09-09';

// Реквизиты оператора / юридического лица. ЕДИНСТВЕННОЕ место — страницы /terms и
// /privacy берут отсюда (рендер в _legal-doc.ejs). Значение поля — либо строка (одно
// на все языки), либо { ka, ru, en }. Пустое поле показывается как «уточняется…»
// (REQUISITE_PENDING в legal-content.js).
const SERVICE_REQUISITES = {
  entityName: {
    ka: 'ინდ. მეწარმე არტურ ბეჯანიან',
    ru: 'ИП Артур Беджанян',
    en: 'Individual Entrepreneur Artur Bejanyan',
  },
  idCode: '304829194', // 9-значный идент. код ИП (реестр NAPR)
  legalAddress: {
    ka: 'საქართველო, ქ. თბილისი, კრწანისის რაიონი, ნინო და ილია ნაკაშიძეების ქუჩა N1 (ყოფ. ავლევი), ბინა N3, შენობა N3',
    ru: 'Грузия, г. Тбилиси, Крцанисский район, ул. Нино и Илии Накашидзе N1 (быв. Авлеви), кв. N3, здание N3',
    en: 'Georgia, Tbilisi, Krtsanisi district, Nino and Ilia Nakashidze St. N1 (former Avlevi), Apt. N3, Building N3',
  },
  email: 'support@xtender.ge',
  website: 'https://xtender.ge',
  vatStatus: {
    ka: 'დღგ-ს გადამხდელი არ არის; ტარიფები მითითებულია დღგ-ს გარეშე',
    ru: 'Не плательщик НДС; тарифы указаны без НДС',
    en: 'Not a VAT payer; tariffs are stated exclusive of VAT',
  },
  // Банковские реквизиты для пополнения баланса исполнителя — одинаковы на всех языках.
  bankName: 'Bank of Georgia (საქართველოს ბანკი)',
  bankAccount: 'GE95BG0000000613339218',
  bankSwift: 'BAGAGE22',
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
