// Кнопка «Решить с ChatGPT» (partials/ai-solve.ejs). Ссылка открывает ChatGPT сама; скрипт по нажатию копирует полный
// запрос (если ChatGPT откроется без текста, его можно вставить) и считает события. Сайт не узнаёт, открылся ли ChatGPT
// и отправил ли человек запрос, поэтому события — только то, что видно на этой странице: показ кнопки, нажатие,
// подготовленный запрос, копирование, попытка открыть ChatGPT. Текст запроса в статистику не уходит; страницу и время
// Google Analytics записывает сам.
(function () {
  function device() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    return /Mobi/i.test(ua) ? 'mobile' : 'desktop';
  }

  function track(root, name, extra) {
    if (typeof window.xtTrack !== 'function') return;
    var params = { ai_scenario: root.getAttribute('data-scenario'), ai_lang: document.documentElement.lang || '', ai_device: device() };
    for (var key in extra || {}) params[key] = extra[key];
    window.xtTrack(name, params);
  }

  // Старый способ — для браузеров без доступа к буферу обмена (страница не по https, встроенные браузеры).
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function say(root, text) {
    var status = root.querySelector('.ai-solve-status');
    if (status) status.textContent = text || '';
  }

  document.querySelectorAll('[data-ai-solve]').forEach(function (root) {
    var prompt = root.getAttribute('data-prompt') || '';
    var variant = root.getAttribute('data-variant');
    var open = root.querySelector('.ai-solve-open');
    var copy = root.querySelector('.ai-solve-copy');

    // Показ — один раз, когда кнопка видна хотя бы наполовину.
    if ('IntersectionObserver' in window) {
      var watcher = new IntersectionObserver(function (entries) {
        if (!entries.some(function (entry) { return entry.isIntersecting; })) return;
        watcher.disconnect();
        track(root, 'ai_button_view');
      }, { threshold: 0.5 });
      watcher.observe(root);
    }

    // Переход не останавливаем: его делает сама ссылка по нажатию человека, так телефон может открыть приложение.
    open.addEventListener('click', function () {
      track(root, 'ai_button_click');
      track(root, 'ai_prompt_generated', { ai_variant: variant, ai_length: prompt.length });
      copyText(prompt).then(function (ok) {
        if (!ok) return;
        track(root, 'ai_prompt_copied', { ai_via: 'open' });
        say(root, root.getAttribute('data-opened'));
      });
      track(root, 'ai_chatgpt_open_attempt', { ai_variant: variant });
    });

    copy.addEventListener('click', function () {
      copyText(prompt).then(function (ok) {
        say(root, root.getAttribute(ok ? 'data-copied' : 'data-copy-failed'));
        if (ok) track(root, 'ai_prompt_copied', { ai_via: 'button' });
      });
    });
  });
})();
