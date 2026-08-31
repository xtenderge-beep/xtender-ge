function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const withCountry = digits.length === 9 ? `995${digits}` : digits;
  return `+${withCountry}`;
}

// Заявки хранят телефон ровно в том виде, как его ввёл клиент (только пробелы срезаны),
// поэтому один и тот же номер в БД может быть как `+995XXXXXXXXX`, так и `995XXXXXXXXX`
// или `XXXXXXXXX`. Для поиска «была ли у этого номера заявка» сверяем по всем вариантам.
function phoneVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return digits ? [digits] : [];
  const last9 = digits.slice(-9);
  return [...new Set([`+995${last9}`, `995${last9}`, last9, `+${digits}`, digits])];
}

module.exports = { toE164, phoneVariants };
