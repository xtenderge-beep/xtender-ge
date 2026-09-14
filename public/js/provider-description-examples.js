(function () {
  'use strict';

  const input = document.getElementById('descriptionInput');
  if (!input) return;

  let examples;
  try { examples = JSON.parse(input.dataset.descriptionExamples || '[]'); }
  catch (_) { return; }
  examples = Array.isArray(examples) ? examples.filter(text => typeof text === 'string' && text.trim()) : [];
  if (examples.length < 2) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = !('IntersectionObserver' in window);
  let index = 0;
  let timer = null;
  let letters = Array.from(examples[index]);
  let position = letters.length;

  function stop() {
    window.clearTimeout(timer);
    timer = null;
  }

  function canPlay() {
    return visible && !document.hidden && !motion.matches &&
      document.activeElement !== input && !input.value;
  }

  function schedule() {
    stop();
    if (canPlay()) timer = window.setTimeout(tick, position < letters.length ? 32 : 4200);
  }

  function tick() {
    timer = null;
    if (!canPlay()) return;
    if (position >= letters.length) {
      index = (index + 1) % examples.length;
      letters = Array.from(examples[index]);
      position = 0;
    }
    position++;
    // Examples are only hints: they must never become submitted profile text.
    input.placeholder = letters.slice(0, position).join('');
    schedule();
  }

  function showCompleteExample() {
    stop();
    position = letters.length;
    input.placeholder = examples[index];
  }

  input.addEventListener('focus', showCompleteExample);
  input.addEventListener('input', showCompleteExample);
  input.addEventListener('blur', schedule);
  document.addEventListener('visibilitychange', schedule);
  motion.addEventListener('change', function () {
    showCompleteExample();
    schedule();
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
      visible = entries.some(entry => entry.isIntersecting);
      schedule();
    }, { threshold: 0.15 });
    observer.observe(input);
  }
  schedule();
})();
