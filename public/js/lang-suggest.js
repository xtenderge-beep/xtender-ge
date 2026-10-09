// Строка под шапкой про язык страницы (partials/lang-suggest.ejs).
// Человек мог прийти на версию не на своём языке: по рекламе, по чужой ссылке. Переключатель в шапке
// маленький, поэтому под шапкой стоит строка.
//  - Обычно это подсказка на языке браузера: «эта страница есть на вашем языке» и кнопка.
//  - На английской версии страницы задачи это выбор из трёх крупных кнопок, он уже стоит в странице
//    (data-mode="choose"): туда ведёт реклама по грузинским запросам.
// Страница никого сама не переадресует: поисковик и человек видят одно и то же, человек решает сам.
(function () {
  var TEXT = {
    ka: ['ეს გვერდი ქართულადაც არის.', 'ქართულად გახსნა'],
    ru: ['Эта страница есть на русском.', 'Открыть по-русски'],
    en: ['This page is available in English.', 'Open in English'],
  };

  // Какой язык предложить. preferred — языки браузера по порядку, pageLang — язык страницы,
  // available — языки, на которых эта страница есть. Возвращает код языка или null.
  function pick(preferred, pageLang, available) {
    var site = [];
    (preferred || []).forEach(function (tag) {
      var code = String(tag || '').toLowerCase().slice(0, 2);
      if (TEXT[code] && site.indexOf(code) < 0) site.push(code);
    });
    if (!site.length) return null;
    // Английский в браузере часто стоит первым «как был», а грузинский добавлен вторым: такой
    // человек читает по-грузински, и на английской странице ему стоит предложить грузинскую.
    var want = site[0] === 'en' && site.indexOf('ka') > 0 ? 'ka' : site[0];
    return want !== pageLang && (available || []).indexOf(want) >= 0 ? want : null;
  }
  window.xtLangSuggestPick = pick;

  var box = document.getElementById('langSuggest');
  if (!box) return;
  var KEY = 'xt_lang_chosen';
  var remember = function () { try { localStorage.setItem(KEY, '1'); } catch (e) {} };
  // Сколько людей меняют язык с этой строки: без личных данных, только язык.
  var count = function (language) { if (window.xtTrack) window.xtTrack('language_suggest_click', { language: language }); };
  // Метки рекламы из адреса (gclid, utm_*) переходят на другую языковую версию вместе с человеком.
  var withAdParams = function (href) {
    var target = new URL(href, location.origin);
    new URLSearchParams(location.search).forEach(function (value, key) { if (key !== 'lang') target.searchParams.set(key, value); });
    return target.pathname + target.search;
  };
  var close = function () { box.hidden = true; remember(); };

  // Кто уже выбрал язык сам (переключателем, этой строкой или закрыл её), того не трогаем.
  document.querySelectorAll('.lang-btn').forEach(function (link) { link.addEventListener('click', remember); });
  try { if (localStorage.getItem(KEY) === '1') { box.hidden = true; return; } } catch (e) {}
  document.getElementById('langSuggestClose').addEventListener('click', close);

  var pageLang = box.getAttribute('data-page-lang');
  if (box.getAttribute('data-mode') === 'choose') {
    box.querySelectorAll('.lang-choice').forEach(function (link) {
      var language = link.getAttribute('data-lang');
      link.href = withAdParams(link.getAttribute('href'));
      link.addEventListener('click', function (event) {
        count(language);
        // Нажатие на язык самой страницы — это «оставьте как есть».
        if (language === pageLang) { event.preventDefault(); close(); } else remember();
      });
    });
    return;
  }

  var links = {};
  try { links = JSON.parse(box.getAttribute('data-links')) || {}; } catch (e) { return; }
  var want = pick(navigator.languages || [navigator.language], pageLang, Object.keys(links));
  if (!want) return;
  var go = document.getElementById('langSuggestGo');
  var text = document.getElementById('langSuggestText');
  go.href = withAdParams(links[want]);
  go.textContent = TEXT[want][1];
  go.lang = want;
  text.textContent = TEXT[want][0];
  text.lang = want;
  go.addEventListener('click', function () { remember(); count(want); });
  box.hidden = false;
})();
