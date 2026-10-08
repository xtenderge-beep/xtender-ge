// Google Analytics 4 на открытых страницах xtender.ge; из него Google Ads берёт конверсии.
// Сервер подключает этот файл только там, где задан идентификатор потока (src/config/googleTag.js).
// В Google уходит адрес страницы без служебных параметров. Телефон, текст заявки и ссылки на заявки
// и кабинеты не уходят никогда. Сотрудники и роботы не считаются, как и в visit.js.
(function () {
  function run(cb) { if (typeof cb === 'function') cb(); }
  // Страница вызывает xtTrack в любом случае; без Google он сразу продолжает её работу.
  window.xtTrack = function (name, params, cb) { run(cb); };
  try {
    var id = document.currentScript && document.currentScript.getAttribute('data-id');
    if (!id || navigator.webdriver) return;
    try { if (localStorage.getItem('xt_staff') === '1') return; } catch (e) {}

    // В адресе оставляем только рекламные метки: по ним Google узнаёт кампанию и клик.
    var CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'dclid', 'srsltid', '_gl'];
    var query = new URLSearchParams();
    new URLSearchParams(location.search).forEach(function (value, key) {
      if (/^(utm_|gad_)/.test(key) || CLICK_IDS.indexOf(key) !== -1) query.append(key, value);
    });
    var search = query.toString();
    var settings = {
      page_location: location.origin + location.pathname + (search ? '?' + search : ''),
      // Только статистика и учёт конверсий: без ремаркетинга и персонализации рекламы.
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    };
    // Со своей страницы человек мог прийти с адреса заявки или кабинета: оставляем только сайт.
    var referrer = document.referrer || '';
    if (referrer === location.origin || referrer.indexOf(location.origin + '/') === 0) settings.page_referrer = location.origin + '/';

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, settings);

    // Библиотека Google грузится после самой страницы и не задерживает её показ.
    var loaded = false;
    function load() {
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
      script.onload = function () { loaded = true; };
      document.head.appendChild(script);
    }
    if (document.readyState === 'complete') load(); else window.addEventListener('load', load);

    // cb — продолжение, которое уводит со страницы (в заявку или кабинет). Библиотека Google копит события
    // до 5 секунд, а при уходе со страницы отправляет накопленное сразу. Поэтому ждём только её ответ
    // «событие принято» (несколько миллисекунд), но не дольше 0,8 с; если библиотека не загрузилась
    // (блокировщик), не ждём совсем.
    window.xtTrack = function (name, params, cb) {
      var wait = typeof cb === 'function' && loaded, finished = false;
      function finish() { if (!finished) { finished = true; run(cb); } }
      try {
        var data = {};
        for (var key in params || {}) data[key] = params[key];
        if (wait) { data.event_callback = finish; setTimeout(finish, 800); }
        window.gtag('event', name, data);
      } catch (e) { wait = false; }
      if (!wait) finish();
    };
  } catch (e) {}
})();
