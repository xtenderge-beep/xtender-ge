// Пиксель Meta на открытых страницах xtender.ge: по нему реклама в Facebook и Instagram видит заявки.
// Сервер подключает этот файл только там, где задан идентификатор (src/config/metaPixel.js).
// Пиксель сам записывает адрес страницы и адрес, с которого пришли, и заменить их нельзя. Поэтому на
// просмотре, где в одном из них есть ссылка менеджера, промокод или адрес заявки или кабинета, пиксель
// не включается совсем. Телефон, текст заявки и нажатия на кнопки в Meta не уходят никогда.
// Сотрудники и роботы не считаются, как и в visit.js.
(function () {
  try {
    var tag = document.currentScript;
    var id = tag && tag.getAttribute('data-id');
    if (!id || navigator.webdriver) return;
    // Проверка из Events Manager («Тестирование событий»): он открывает сайт в том же браузере, а у
    // сотрудника пиксель выключен. Адрес с ?pixeltest=1 включает пиксель и у сотрудника, до закрытия вкладки.
    var testing = false;
    try {
      if (new URLSearchParams(location.search).get('pixeltest') === '1') sessionStorage.setItem('xt_pixel_test', '1');
      testing = sessionStorage.getItem('xt_pixel_test') === '1';
    } catch (e) {}
    try { if (!testing && localStorage.getItem('xt_staff') === '1') return; } catch (e) {}

    // Без списка открытых страниц пиксель не включается: лучше потерять просмотр, чем отдать ссылку.
    var pages = new RegExp(tag.getAttribute('data-pages') || '^$');
    var secret = (tag.getAttribute('data-private') || '').split(',');
    function open(path, search) {
      if (!pages.test(path)) return false;
      var ok = true;
      new URLSearchParams(search).forEach(function (value, key) { if (secret.indexOf(key) !== -1) ok = false; });
      return ok;
    }
    if (!open(location.pathname, location.search)) return;
    // Со своей страницы человек мог прийти с адреса заявки или кабинета.
    var referrer = document.referrer || '';
    if (referrer === location.origin || referrer.indexOf(location.origin + '/') === 0) {
      var from = new URL(referrer);
      if (!open(from.pathname, from.search)) return;
    }

    // Заготовка Meta: вызовы копятся в очереди, пока не загрузится библиотека.
    var fbq = window.fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments); else fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
    // Без автоматического сбора: иначе пиксель сам отправляет подписи нажатых кнопок и описание страницы.
    fbq('set', 'autoConfig', false, id);
    fbq('init', id);
    fbq('track', 'PageView');

    // Библиотека Meta грузится после самой страницы и не задерживает её показ.
    function load() {
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(script);
    }
    if (document.readyState === 'complete') load(); else window.addEventListener('load', load);

    // Цели для рекламы: заявка, открытый номер исполнителя, регистрация исполнителя. Шаги формы в Meta
    // не уходят. Страница вызывает xtTrack (google-tag.js); цель уходит в Meta, остальное идёт дальше.
    var GOALS = { generate_lead: 'Lead', catalog_contact_open: 'Contact', sign_up: 'CompleteRegistration' };
    var next = window.xtTrack;
    window.xtTrack = function (name, params, cb) {
      try { if (GOALS[name]) fbq('track', GOALS[name]); } catch (e) {}
      if (typeof next === 'function') next(name, params, cb); else if (typeof cb === 'function') cb();
    };
  } catch (e) {}
})();
