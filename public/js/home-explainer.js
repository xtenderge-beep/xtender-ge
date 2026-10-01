// Анимация «как работает заявка» на главной (src/views/partials/home-explainer.ejs).
// Время в секундах задают атрибуты: data-at — элемент появляется (класс on), data-off —
// исчезает (hx-gone), data-until — разовое движение закончено (done), data-states — смена
// состояний «секунда:имя …», data-type-at/-dur — печать текста. Кадр считается из времени,
// поэтому пауза и перемотка работают без накопленного состояния.
// Свёрнута под кнопкой «Как это работает». После раскрытия играет один раз, пока блок на экране.
// Если человек начал заполнять форму, движение не отвлекает его: показываем финальный кадр.
(function () {
  var root = document.getElementById('homeExplainer');
  if (!root) return;

  var END = 17.5;
  var STEPS = [0, 4.8, 8.8, 13.6];
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var vis = root.querySelector('.hx-vis');
  var canvas = root.querySelector('.hx-canvas');
  var nowEl = document.getElementById('hxNow');
  var dots = root.querySelectorAll('.hx-dots li');
  var stepTexts = Array.prototype.map.call(root.querySelectorAll('#hxSteps li'), function (li) { return li.textContent; });

  function all(selector) { return Array.prototype.slice.call(root.querySelectorAll(selector)); }
  function num(node, attr) { return parseFloat(node.getAttribute(attr)); }
  function timed(attr) { return all('[' + attr + ']').map(function (node) { return [node, num(node, attr)]; }); }

  var atEls = timed('data-at');
  var offEls = timed('data-off');
  var untilEls = timed('data-until');
  var typedEls = all('[data-type-at]').map(function (node) {
    return { node: node, text: node.textContent, at: num(node, 'data-type-at'), dur: num(node, 'data-type-dur'), shown: -1 };
  });
  var stateEls = all('[data-states]').map(function (node) {
    return {
      node: node,
      seq: node.getAttribute('data-states').trim().split(/\s+/).map(function (pair) {
        var i = pair.indexOf(':');
        return [parseFloat(pair.slice(0, i)), pair.slice(i + 1)];
      }),
    };
  });

  function fit() {
    var width = vis.clientWidth;
    if (width) canvas.style.setProperty('--hx-k', (width / 480).toFixed(4));
  }

  var t = 0, step = -1;
  function render() {
    atEls.forEach(function (p) { p[0].classList.toggle('on', t >= p[1]); });
    offEls.forEach(function (p) { p[0].classList.toggle('hx-gone', t >= p[1]); });
    untilEls.forEach(function (p) { p[0].classList.toggle('done', t >= p[1]); });
    typedEls.forEach(function (ty) {
      var count = t < ty.at ? 0 : Math.min(ty.text.length, Math.round((t - ty.at) / ty.dur * ty.text.length));
      if (count !== ty.shown) { ty.node.textContent = ty.text.slice(0, count); ty.shown = count; }
    });
    stateEls.forEach(function (st) {
      var value = st.seq[0][1];
      st.seq.forEach(function (p) { if (t >= p[0]) value = p[1]; });
      if (st.node.getAttribute('data-state') !== value) st.node.setAttribute('data-state', value);
    });
    var current = 0;
    STEPS.forEach(function (at, i) { if (t >= at) current = i; });
    if (current !== step) {
      step = current;
      Array.prototype.forEach.call(dots, function (dot, i) {
        dot.classList.toggle('is-current', i === current);
        dot.classList.toggle('is-done', i < current);
      });
      if (stepTexts[current]) nowEl.textContent = stepTexts[current];
    }
  }

  var playing = false, last = null, stopped = reduce, visible = false;
  function loop(stamp) {
    if (!playing) return;
    if (last !== null) t = Math.min(END, t + (stamp - last) / 1000);
    last = stamp;
    render();
    if (t >= END) { pause(); return; }
    requestAnimationFrame(loop);
  }
  function play() {
    if (playing || t >= END) return;
    playing = true;
    last = null;
    root.classList.remove('hx-paused');
    requestAnimationFrame(loop);
  }
  function pause() {
    playing = false;
    root.classList.add('hx-paused');
  }
  function seek(to) {
    t = Math.max(0, Math.min(END, to));
    root.classList.add('hx-snap');
    render();
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('hx-snap'); }); });
  }

  root.querySelector('.hx-replay').addEventListener('click', function () {
    stopped = false;
    seek(0);
    play();
  });

  // Свёрнуто по умолчанию. Раскрыл — значит, хочет посмотреть: всегда с начала (или сразу
  // финальный кадр при «уменьшить движение»). Свернул — пауза.
  var toggle = document.getElementById('hxToggle');
  var panel = document.getElementById('hxPanel');
  var toggleText = toggle.querySelector('.hx-toggle-t');
  toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggleText.textContent = toggle.getAttribute(open ? 'data-label-close' : 'data-label-open');
    panel.hidden = !open;
    if (!open) { pause(); return; }
    stopped = reduce;
    seek(reduce ? END : 0);
    fit();
  });

  var form = document.getElementById('post-section');
  if (form) form.addEventListener('focusin', function () {
    if (panel.hidden || stopped || t >= END) return;
    stopped = true;
    pause();
    seek(END);
  });

  fit();
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(vis);
  else window.addEventListener('resize', fit);
  root.classList.add('is-ready', 'hx-paused');
  render();
  if (reduce) seek(END);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible = entry.intersectionRatio >= 0.35;
        if (visible && !stopped) play();
        else if (!visible) pause();
      });
    }, { threshold: [0, 0.35, 0.7] }).observe(vis);
  } else if (!stopped) {
    visible = true;
    play();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause();
    else if (visible && !stopped) play();
  });
})();
