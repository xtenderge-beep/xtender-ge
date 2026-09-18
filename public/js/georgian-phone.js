(function (root) {
  'use strict';
  const messages = {
    ru: 'Укажите грузинский номер: +995 и 9 цифр. Иностранные номера не поддерживаются.',
    en: 'Enter a Georgian number: +995 followed by 9 digits. Foreign numbers are not supported.',
    ka: 'მიუთითეთ ქართული ნომერი: +995 და 9 ციფრი. უცხოური ნომრები არ არის მხარდაჭერილი.',
  };
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const phone = value.replace(/\s/g, '');
    return /^\+995[0-9]{9}$/.test(phone) ? phone : null;
  }
  const policy = {
    normalize,
    isValid: value => normalize(value) !== null,
    message: language => messages[language] || messages.en,
  };
  if (typeof module === 'object' && module.exports) { module.exports = policy; return; }
  root.GeorgianPhone = policy;
  policy.validate = function (input, report = true) {
    const valid = policy.isValid(input.value);
    input.setCustomValidity(valid ? '' : policy.message(document.documentElement.lang));
    if (!valid && report) input.reportValidity();
    return valid;
  };
  // Поле всегда начинается с '+995' (см. value="+995" в разметке) — здесь запрещаем
  // редактирование этого префикса, чтобы его нельзя было стереть/заменить на код другой
  // страны. Правим только то, что относится к самому префиксу; остальную валидацию формата
  // (9 цифр и т.п.) по-прежнему делает policy.validate/сервер.
  const PREFIX = '+995';
  // Автозаполнение (сохранённый контакт из мобильной клавиатуры/менеджера паролей,
  // как в примере с "mobile 577 052 785" на подсказке над клавиатурой) заменяет всё
  // значение поля напрямую, не через обычный ввод символов — 'beforeinput'/'paste'
  // ниже его не видят вовсе. Чиним значение на каждое 'input', в чём бы ни была
  // причина изменения: если префикса нет — восстанавливаем его перед оставшимися
  // цифрами, а не поверх них.
  function repairPrefix(input) {
    if (input.value.startsWith(PREFIX)) return;
    let digits = input.value.replace(/\D/g, '');
    if (digits.startsWith('995')) digits = digits.slice(3);
    input.value = PREFIX + digits;
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
  }
  function lockPrefix(input) {
    input.addEventListener('beforeinput', function (e) {
      if (e.inputType === 'insertFromPaste') return; // обрабатывается ниже, через 'paste'
      const start = input.selectionStart, end = input.selectionEnd;
      if (e.inputType === 'deleteContentBackward') {
        if (start <= PREFIX.length && end <= PREFIX.length) e.preventDefault();
        return;
      }
      if (start < PREFIX.length) e.preventDefault();
    });
    input.addEventListener('paste', function (e) {
      e.preventDefault();
      const text = (e.clipboardData || root.clipboardData).getData('text');
      let digits = text.replace(/\D/g, '');
      if (digits.startsWith('995')) digits = digits.slice(3);
      // Clamp the replaced range to start after the prefix — a selection reaching into
      // (or a caret inside) the prefix pastes the digits right after it instead of
      // overwriting the whole field, so anything already typed past the prefix survives.
      const start = Math.max(input.selectionStart, PREFIX.length);
      const end = Math.max(input.selectionEnd, PREFIX.length);
      input.setRangeText(digits, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-georgian-phone]').forEach(function (input) {
      input.title = policy.message(document.documentElement.lang);
      input.addEventListener('input', function () { repairPrefix(input); policy.validate(input, false); });
      input.addEventListener('change', function () { repairPrefix(input); policy.validate(input, false); });
      input.addEventListener('blur', function () { repairPrefix(input); policy.validate(input, false); });
      lockPrefix(input);
    });
  });
})(typeof window === 'object' ? window : globalThis);
