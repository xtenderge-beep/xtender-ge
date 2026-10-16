// Поиск исполнителей по словам заказчика на тестовой главной /demo: «грузчики», «mushebi», «газель»,
// «ევაკუატორი». Слова услуг и запрос сводятся к одной латинице, поэтому грузинский, русский и латиница
// находят друг друга (ქ = q = k, წ = w = ts, ხ = x = kh, ფ = f = p). Совпадение по началу слова: «груз»
// находит «грузчики», «грузчиков» — «грузчики». Короткие слова (до 4 букв) совпадают только целиком или
// как начало: так «ванна» не находит «van», а «лифта» — «lift» из названия автовышки. Один файл для сервера (тест) и браузера.
(function (root) {
  var RU = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'j', 'з': 'z', 'и': 'i',
    'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ъ': '', 'ы': 'i', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya',
  };
  // Так грузины пишут латиницей в переписке и на латинской раскладке.
  var KA = {
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k',
    'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'j', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u',
    'ფ': 'f', 'ქ': 'k', 'ღ': 'g', 'ყ': 'k', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'c', 'ძ': 'dz', 'წ': 'c', 'ჭ': 'ch',
    'ხ': 'x', 'ჯ': 'j', 'ჰ': 'h',
  };

  function fold(text) {
    var latin = '';
    var lower = String(text == null ? '' : text).toLowerCase();
    for (var i = 0; i < lower.length; i++) {
      var ch = lower.charAt(i);
      latin += Object.prototype.hasOwnProperty.call(KA, ch) ? KA[ch] : Object.prototype.hasOwnProperty.call(RU, ch) ? RU[ch] : ch;
    }
    return latin
      .replace(/kh/g, 'x').replace(/ts/g, 'c').replace(/w/g, 'c').replace(/q/g, 'k')
      .replace(/zh/g, 'j').replace(/gh/g, 'g').replace(/f/g, 'p')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function tokens(text, minLength) {
    var min = minLength || 2;
    return fold(text).split(' ').filter(function (word) { return word.length >= min; });
  }

  // query — слово запроса, word — слово услуги или описания (оба уже приведены fold).
  function wordsMatch(query, word) {
    if (query === word) return true;
    if (query.length >= 3 && word.indexOf(query) === 0) return true;
    var shorter = Math.min(query.length, word.length);
    if (shorter < 5) return false;
    var common = 0;
    while (common < shorter && query.charAt(common) === word.charAt(common)) common++;
    return common >= 4 && common >= shorter * 0.75;
  }

  function anyWord(query, words) {
    for (var i = 0; i < words.length; i++) if (wordsMatch(query, words[i])) return true;
    return false;
  }

  // entries — [{ services: ['movers'], words: 'грузчик mushebi …' }]. Возвращает функцию: запрос → услуги.
  function serviceMatcher(entries) {
    var index = entries.map(function (entry) { return { services: entry.services, words: tokens(entry.words) }; });
    return function (query) {
      var found = [];
      tokens(query, 3).forEach(function (q) {
        index.forEach(function (entry) {
          if (!anyWord(q, entry.words)) return;
          entry.services.forEach(function (service) { if (found.indexOf(service) === -1) found.push(service); });
        });
      });
      return found;
    };
  }

  // Каждое слово запроса есть в тексте (имя, описание, отметки карточки).
  function textMatches(query, text) {
    var asked = tokens(query, 3);
    if (!asked.length) return false;
    var words = tokens(text);
    return asked.every(function (q) { return anyWord(q, words); });
  }

  var api = { fold: fold, tokens: tokens, wordsMatch: wordsMatch, serviceMatcher: serviceMatcher, textMatches: textMatches };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ServiceSearch = api;
})(this);
