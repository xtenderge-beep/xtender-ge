const { translate } = require('./i18n');
const { getBaseUrl } = require('./url');

// Версия публичной оферты + текста согласия у чекбокса на /join. Поднимать при ЛЮБОМ
// изменении `terms_body` или `join_terms_label` в i18n.js — по этой строке регулятор
// (PDPS) понимает, какую именно редакцию условий принял конкретный человек.
// Формат: vMAJOR.MINOR-YYYY-MM-DD, где дата — момент вступления редакции в силу.
const TERMS_VERSION = 'v1.0-2026-08-27';

// Точный текст согласия рядом с кнопкой подтверждения кода — снимаем на сервере из
// словаря, не доверяя тому, что прислал клиент. Для флоу без явного чекбокса согласия
// (заявка клиента, вход в кабинет, отзыв) осмысленного текста нет — вернём null.
//
// baseUrl — абсолютный адрес, на котором реально был пользователь (req.protocol + host);
// ссылку на оферту храним абсолютной, чтобы в аудите не было двусмысленности «а на каком
// домене он это видел». Фолбэк — канонический DOMAIN.
function consentSnapshot(lang, baseUrl) {
  const t = translate(lang);
  const base = (baseUrl || getBaseUrl()).replace(/\/+$/, '');
  return `${t('join_terms_label')} ${t('join_terms_link')}: ${base}/terms`;
}

module.exports = { TERMS_VERSION, consentSnapshot };
