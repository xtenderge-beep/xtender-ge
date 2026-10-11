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
    var body = JSON.stringify({
      p: location.pathname, r: document.referrer || '',
      us: utm, um: q.get('utm_medium') || '', uc: q.get('utm_campaign') || '',
      l: (document.documentElement.lang || '').slice(0, 2), w: window.innerWidth || 0, s: staff ? 1 : 0
    });
    var blob = new Blob([body], { type: 'application/json' });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/v', blob))) {
      fetch('/api/v', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' }).catch(function () {});
    }
  } catch (e) {}
})();
