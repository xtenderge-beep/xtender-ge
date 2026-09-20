// Service notifications and recoverable API errors. No marketing or consent text.
const messages = {
  lead: ['Xtender: {test}новая заявка №{id}: {link}', 'Xtender: {test}new request #{id}: {link}', 'Xtender: {test}ახალი განაცხადი №{id}: {link}'],
  revision: ['Xtender: уточните заявку. Комментарий проверки и исправление: {link}', 'Xtender: your request needs more details. View feedback and update it: {link}', 'Xtender: განაცხადს დაზუსტება სჭირდება. ნახეთ კომენტარი და შეასწორეთ: {link}'],
  code: ['Xtender: код {code}. Никому его не сообщайте.', 'Xtender: code {code}. Do not share it.', 'Xtender: კოდი {code}. არავის გაუზიაროთ.'],
  orderCode: ['Xtender: код {code}. Ваша заявка{reference}: {link} Здесь можно закрыть заявку.', 'Xtender: code {code}. Your request{reference}: {link} You can close it here.', 'Xtender: კოდი {code}. თქვენი განაცხადი{reference}: {link} აქ შეგიძლიათ განაცხადის დახურვა.'],
  reviewInvite: ['Xtender: заявка №{id} закрыта. Если исполнитель выполнил работу, оставьте отзыв: {link}', 'Xtender: request #{id} is closed. If a provider did the work, leave a review: {link}', 'Xtender: განაცხადი №{id} დახურულია. თუ შემსრულებელმა სამუშაო შეასრულა, შეაფასეთ: {link}'],
  balanceLow: ['Xtender: на балансе {amount} ₾. Средств осталось мало. Пополнить баланс: {link}', 'Xtender: balance {amount} GEL. Funds are running low. Top up: {link}', 'Xtender: ბალანსზეა {amount} ₾. თანხა იწურება. ბალანსის შევსება: {link}'],
  balanceMissed: ['Xtender: уведомление о заявке не отправлено — недостаточно средств. Пополнить баланс: {link}', 'Xtender: a request notification was not sent due to insufficient funds. Top up: {link}', 'Xtender: განაცხადის შეტყობინება არ გაიგზავნა — თანხა არასაკმარისია. ბალანსის შევსება: {link}'],
  telegramConnected: ['Telegram подключён. Уведомления будут приходить сюда, когда профиль допущен к получению заявок.', 'Telegram connected. Notifications will arrive here when your profile is eligible to receive requests.', 'Telegram დაკავშირებულია. შეტყობინებები აქ მოვა, როდესაც პროფილი განაცხადების მისაღებად მზად იქნება.'],
  rateLimit: ['Слишком много попыток. Попробуйте позже.', 'Too many attempts. Please try again later.', 'ძალიან ბევრი მცდელობაა. სცადეთ მოგვიანებით.'],
  sendFailed: ['Не удалось отправить код. Попробуйте ещё раз.', 'Could not send the code. Please try again.', 'კოდი ვერ გაიგზავნა. სცადეთ ხელახლა.'],
  invalidCode: ['Код неверный или срок его действия истёк. Проверьте код или запросите новый.', 'The code is incorrect or expired. Check it or request a new one.', 'კოდი არასწორია ან ვადა გაუვიდა. შეამოწმეთ ან მოითხოვეთ ახალი კოდი.'],
  invalidPhoneCode: ['Проверьте номер телефона и введите код из SMS.', 'Check your phone number and enter the SMS code.', 'შეამოწმეთ ტელეფონის ნომერი და შეიყვანეთ SMS-კოდი.'],
  unverified: ['Сначала подтвердите номер кодом из SMS.', 'First verify your phone with the SMS code.', 'ჯერ დაადასტურეთ ნომერი SMS-კოდით.'],
  descriptionRequired: ['Опишите, что нужно сделать.', 'Describe what needs to be done.', 'აღწერეთ, რა არის გასაკეთებელი.'],
  nameRequired: ['Введите имя и фамилию.', 'Enter your full name.', 'შეიყვანეთ სახელი და გვარი.'],
  consentRequired: ['Подтвердите условия и согласие на размещение контактов.', 'Accept the terms and consent to publishing your contact details.', 'დაადასტურეთ პირობები და საკონტაქტო მონაცემების გამოქვეყნებაზე თანხმობა.'],
  notFound: ['Страница не найдена. Откройте актуальную ссылку.', 'Page not found. Open a current link.', 'გვერდი ვერ მოიძებნა. გახსენით მოქმედი ბმული.'],
  orderNotFound: ['Заявка не найдена. Проверьте ссылку.', 'Request not found. Check the link.', 'განაცხადი ვერ მოიძებნა. შეამოწმეთ ბმული.'],
  notAllowed: ['Нет доступа к этому действию. Откройте свою заявку по ссылке из SMS.', 'You cannot perform this action. Open your request using the SMS link.', 'ამ მოქმედებაზე წვდომა არ გაქვთ. გახსენით თქვენი განაცხადი SMS-ის ბმულით.'],
  closingReason: ['Выберите причину закрытия заявки.', 'Choose why you are closing the request.', 'აირჩიეთ განაცხადის დახურვის მიზეზი.'],
  invalidCategory: ['Этой услуги нет в заявке. Обновите страницу.', 'This service is not part of the request. Refresh the page.', 'ეს მომსახურება განაცხადში არ არის. განაახლეთ გვერდი.'],
  closed: ['Заявка закрыта.', 'Request closed.', 'განაცხადი დახურულია.'],
  sent: ['Код отправлен.', 'Code sent.', 'კოდი გაგზავნილია.'],
  verified: ['Номер подтверждён.', 'Phone verified.', 'ნომერი დადასტურებულია.'],
  emptyMessage: ['Напишите вопрос для поддержки.', 'Enter your question for support.', 'დაწერეთ შეკითხვა მხარდაჭერისთვის.'],
  noFile: ['Выберите файл чека.', 'Choose a receipt file.', 'აირჩიეთ ქვითრის ფაილი.'],
  invalidInput: ['Проверьте заполненные поля.', 'Check the information you entered.', 'შეამოწმეთ შევსებული ველები.'],
  reviewNotEligible: ['Для этой заявки нельзя оставить отзыв этому исполнителю.', 'You cannot review this provider for this request.', 'ამ განაცხადისთვის ამ შემსრულებლის შეფასება შეუძლებელია.'],
  tgContactButton: ['📱 Отправить номер', '📱 Send my number', '📱 ნომრის გაგზავნა'],
  tgLinkPrompt: ['Отправьте свой номер телефона кнопкой ниже — найду ваш профиль исполнителя и подключу уведомления о заявках сюда.', 'Send your phone number with the button below. I will find your provider profile and connect request notifications here.', 'გამოგზავნეთ თქვენი ტელეფონის ნომერი ქვემოთ მოცემული ღილაკით — მოვძებნი თქვენს შემსრულებლის პროფილს და განაცხადების შეტყობინებებს აქ ჩავრთავ.'],
  tgOwnNumber: ['Отправьте свой номер кнопкой «{button}».', 'Send your own number with the “{button}” button.', 'გამოგზავნეთ თქვენი ნომერი ღილაკით «{button}».'],
  tgNotRegistered: ['На этот номер не зарегистрирован профиль исполнителя. Регистрация: {link}', 'No provider profile is registered for this number. Register here: {link}', 'ამ ნომერზე შემსრულებლის პროფილი რეგისტრირებული არ არის. რეგისტრაცია: {link}'],
  tgQuestionSent: ['✅ Вопрос отправлен модератору. Ответ придёт сюда и в кабинет.', '✅ Your question was sent to the moderator. The reply will arrive here and in your account.', '✅ შეკითხვა მოდერატორს გაეგზავნა. პასუხი აქაც მოვა და კაბინეტშიც.'],
  alreadyReviewed: ['Вы уже оставили отзыв об этом исполнителе.', 'You have already reviewed this provider.', 'თქვენ უკვე შეაფასეთ ეს შემსრულებელი.'],
};
const locales = { ru: 0, en: 1, ka: 2 };
function serviceMessage(key, language, values = {}) {
  if (!Object.hasOwn(messages, key)) throw new Error('Unknown service message: ' + key);
  const text = messages[key][Object.hasOwn(locales, language) ? locales[language] : locales.ka];
  return text.replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
function telegramLanguage(from) {
  const code = String((from && from.language_code) || '').slice(0, 2).toLowerCase();
  return code === 'ka' || code === 'en' ? code : 'ru';
}
serviceMessage.telegramLanguage = telegramLanguage;
module.exports = serviceMessage;
