// Счётчик посещаемости xtender.ge (вкладка «Посещаемость» в админке). Без куки и без
// сторонних сервисов: один запрос на просмотр. Сервер хранит тип страницы, а не адрес.
(function () {
  try {
    if (navigator.webdriver) return;
    var q = new URLSearchParams(location.search);
    var staff = false;
    try { staff = localStorage.getItem('xt_staff') === '1'; } catch (e) {}
    var body = JSON.stringify({
      p: location.pathname, r: document.referrer || '',
      us: q.get('utm_source') || '', um: q.get('utm_medium') || '', uc: q.get('utm_campaign') || '',
      l: (document.documentElement.lang || '').slice(0, 2), w: window.innerWidth || 0, s: staff ? 1 : 0
    });
    var blob = new Blob([body], { type: 'application/json' });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/v', blob))) {
      fetch('/api/v', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' }).catch(function () {});
    }
  } catch (e) {}
})();
