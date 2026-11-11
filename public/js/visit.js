// Счётчик посещаемости xtender.ge (вкладка «Посещаемость» в админке). Без куки и без
// сторонних сервисов: один запрос на просмотр. Сервер хранит тип страницы, а не адрес.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    // Источник входа для заявки (раздел «Источники» в админке): метка ссылки или сайт, с которого
    // пришли. Держится до закрытия вкладки, чтобы смена языка и переходы по сайту его не теряли.
    // Это не кука: уходит на сервер только вместе с формой заявки, и от адреса остаётся один сайт.
    var utm = q.get('utm_source') || '', from = '', entry = null;
    try { var ref = new URL(document.referrer); if (ref.hostname !== location.hostname) from = ref.origin; } catch (e) {}
    try { entry = JSON.parse(sessionStorage.getItem('xt_entry') || 'null'); } catch (e) {}
    // Первый вход во вкладке запоминается; новая метка или внешний сайт после прямого захода его заменяют.
    if (!entry || typeof entry !== 'object' || utm || (from && !entry.us && !entry.r)) {
      entry = { us: utm, r: from };
      try { sessionStorage.setItem('xt_entry', JSON.stringify(entry)); } catch (e) {}
    }
    window.xtEntry = function () { return { us: String(entry.us || ''), r: String(entry.r || '') }; };

    if (navigator.webdriver) return;
    var staff = false;
    try { staff = localStorage.getItem('xt_staff') === '1'; } catch (e) {}
    // Номер вкладки для «Сейчас на сайте» в админке: живёт до закрытия вкладки, не кука и не связан с человеком.
    var tab = '';
    try { tab = sessionStorage.getItem('xt_tab') || ''; } catch (e) {}
    if (!/^[a-z0-9]{8,40}$/.test(tab)) {
      tab = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
      try { sessionStorage.setItem('xt_tab', tab); } catch (e) {}
    }
    var lang = (document.documentElement.lang || '').slice(0, 2);
    var body = JSON.stringify({
      p: location.pathname, r: document.referrer || '',
      us: utm, um: q.get('utm_medium') || '', uc: q.get('utm_campaign') || '',
      l: lang, w: window.innerWidth || 0, s: staff ? 1 : 0, t: tab
    });
    var blob = new Blob([body], { type: 'application/json' });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/v', blob))) {
      fetch('/api/v', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' }).catch(function () {});
    }
    // Пока вкладка на экране — сигнал раз в 30 секунд; вкладку закрыли или ушли со страницы — «ушёл».
    var live = function () {
      if (document.visibilityState !== 'visible') return;
      fetch('/api/v/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true,
        body: JSON.stringify({ p: location.pathname, l: lang, w: window.innerWidth || 0, s: staff ? 1 : 0, t: tab }) }).catch(function () {});
    };
    setInterval(live, 30000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') live(); });
    window.addEventListener('pagehide', function () {
      var bye = new Blob([JSON.stringify({ t: tab })], { type: 'application/json' });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/v/leave', bye))) {
        fetch('/api/v/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: tab }), keepalive: true }).catch(function () {});
      }
    });
  } catch (e) {}
})();
