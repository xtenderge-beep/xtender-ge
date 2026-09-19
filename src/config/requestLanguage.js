const { detectLang } = require('../services/translation.service');

// Язык заявки — по самому тексту, а не по orders.source_lang: тот пуст, если перевод не
// сработал (нет ключа, таймаут) и у заявок до автоперевода, а после правки заявки клиентом
// в него пишется язык страницы, а не текста.
function ofOrder(order) {
  const text = String(order?.description || '').trim();
  return text ? detectLang(text) : null;
}

// Языки, которыми исполнитель владеет по нашим данным: отмеченные при регистрации, а у
// аккаунтов, где их нет, — язык его кабинета.
function readerLanguages(master) {
  const spoken = Array.isArray(master?.spoken_languages) ? master.spoken_languages : [];
  if (spoken.length) return spoken;
  return master?.language ? [master.language] : [];
}

// Подсказка «пишите на языке заявки» нужна только известному исполнителю, у которого этого
// языка нет. Просмотр без ?master= (модератор, случайная ссылка) подсказку не получает.
function needsAdvice(requestLang, master) {
  if (!requestLang || !master) return false;
  const known = readerLanguages(master);
  return known.length > 0 && !known.includes(requestLang);
}

module.exports = { ofOrder, readerLanguages, needsAdvice };
