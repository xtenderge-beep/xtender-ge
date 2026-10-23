// Действия сделки на странице заявки (partials/deal-owner.ejs, partials/deal-provider.ejs): каждая форма с
// data-deal-action отправляется JSON на /api/orders/<token>/deal/<действие>; успех — страница перезагружается (сервер
// показывает новое состояние), отказ — текст ошибки под формой. Чекбоксы — true/false, имя «a.b» — вложенный объект.
(function () {
  var root = document.getElementById('deal');
  if (!root) return;
  var token = root.getAttribute('data-deal-token');
  var lang = root.getAttribute('data-deal-lang');
  var T = {};
  try { T = JSON.parse(root.getAttribute('data-deal-strings') || '{}'); } catch (e) { T = {}; }

  function put(target, name, value) {
    var parts = name.split('.');
    var node = target;
    for (var i = 0; i < parts.length - 1; i += 1) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
    node[parts[parts.length - 1]] = value;
  }

  root.addEventListener('submit', function (event) {
    var form = event.target.closest('form[data-deal-action]');
    if (!form) return;
    event.preventDefault();
    var question = form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) return;
    var data = { lang: lang };
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      put(data, el.name, el.type === 'checkbox' ? el.checked : el.value);
    });
    var error = form.querySelector('[data-deal-error]');
    var ok = form.querySelector('[data-deal-ok]');
    var button = form.querySelector('button');
    if (error) error.classList.add('hidden');
    if (ok) ok.classList.add('hidden');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    fetch('/api/orders/' + encodeURIComponent(token) + '/deal/' + form.getAttribute('data-deal-action'), {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) { return { response: response, body: body }; });
    }).then(function (result) {
      if (result.response.ok && result.body.success) {
        if (ok) { ok.classList.remove('hidden'); if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } return; }
        window.location.reload();
        return;
      }
      if (error) { error.textContent = result.body.message || T.error_generic; error.classList.remove('hidden'); }
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }).catch(function () {
      if (error) { error.textContent = T.error_generic; error.classList.remove('hidden'); }
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    });
  });

  root.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy-target]');
    if (!button) return;
    var field = document.getElementById(button.getAttribute('data-copy-target'));
    if (!field) return;
    var done = function () { var before = button.textContent; button.textContent = T.copied || before; setTimeout(function () { button.textContent = before; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(field.value).then(done, function () { field.select(); document.execCommand('copy'); done(); });
    else { field.select(); document.execCommand('copy'); done(); }
  });
}());
