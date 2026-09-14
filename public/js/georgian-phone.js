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
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-georgian-phone]').forEach(function (input) {
      input.title = policy.message(document.documentElement.lang);
      input.addEventListener('input', function () { policy.validate(input, false); });
      input.addEventListener('blur', function () { policy.validate(input, false); });
    });
  });
})(typeof window === 'object' ? window : globalThis);
