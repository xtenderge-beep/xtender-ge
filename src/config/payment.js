// Реквизиты для пополнения баланса исполнителя. Перевод ручной: исполнитель
// переводит на этот счёт, прикрепляет чек в личном кабинете, модератор
// получает чек в Telegram и начисляет баланс командой /topup.
module.exports = {
  BANK_ACCOUNT: 'GE22BG0000000612888318',
  BANK_NAME: 'Bank of Georgia',
  RECIPIENT_NAME: 'xtender',
  MIN_TOPUP_GEL: 5,
};
