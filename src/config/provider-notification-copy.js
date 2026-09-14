// Данные для иллюстрации на /join: "вот как выглядит заявка у исполнителя" —
// уведомление → открытая заявка → кнопки "Позвонить"/WhatsApp (см.
// home-examples-copy.js для того же приёма на главной). Категории реальные
// (src/config/serviceTypes.js), по одной на категорию, чтобы водитель,
// грузчик и эвакуаторщик каждый узнал свою заявку.
module.exports = {
  ka: [
    {
      emoji: '🚚',
      notification: 'ახალი განაცხადი: გადასახლება, ვაკე → საბურთალო',
      body: '2-ოთახიანი ბინა, დივანი და კარადა, მე-5 სართული, ლიფტის გარეშე. კლიენტი ზარს ელოდება.',
    },
    {
      emoji: '💪',
      notification: 'ახალი განაცხადი: მუშები, მე-8 სართული',
      body: '20 ფურცელი გიფსკარტონის ატანა, ლიფტის გარეშე.',
    },
    {
      emoji: '🛻',
      notification: 'ახალი განაცხადი: ევაკუატორი, ვაკე',
      body: 'მანქანა არ ირთვება, სერვისში გადაზიდვაა საჭირო.',
    },
    {
      emoji: '🧹',
      notification: 'ახალი განაცხადი: ნაგვის გატანა, დიდუბე',
      body: 'სამშენებლო ნაგავი, მე-3 სართული, ლიფტის გარეშე.',
    },
    {
      emoji: '🏗️',
      notification: 'ახალი განაცხადი: ავტოამწე, საბურთალო',
      body: 'მასალის მიწოდება მე-6 სართულზე, ფანჯრიდან.',
    },
  ],
  ru: [
    {
      emoji: '🚚',
      notification: 'Новая заявка: переезд, Ваке → Сабуртало',
      body: '2-комнатная квартира, диван и шкаф, 5 этаж, без лифта. Клиент ждёт звонка.',
    },
    {
      emoji: '💪',
      notification: 'Новая заявка: грузчики, 8 этаж',
      body: 'Поднять 20 листов гипсокартона, лифта нет.',
    },
    {
      emoji: '🛻',
      notification: 'Новая заявка: эвакуатор, Ваке',
      body: 'Машина не заводится, нужно отбуксировать в сервис.',
    },
    {
      emoji: '🧹',
      notification: 'Новая заявка: вывоз мусора, Дидубе',
      body: 'Строительный мусор, 3 этаж, лифта нет.',
    },
    {
      emoji: '🏗️',
      notification: 'Новая заявка: автовышка, Сабуртало',
      body: 'Подать материал на 6 этаж через окно.',
    },
  ],
  en: [
    {
      emoji: '🚚',
      notification: 'New request: moving, Vake → Saburtalo',
      body: "2-room apartment, a sofa and a wardrobe, 5th floor, no elevator. Client is waiting for a call.",
    },
    {
      emoji: '💪',
      notification: 'New request: movers, 8th floor',
      body: 'Carry 20 sheets of drywall, no elevator.',
    },
    {
      emoji: '🛻',
      notification: 'New request: tow truck, Vake',
      body: "Car won't start, needs towing to a shop.",
    },
    {
      emoji: '🧹',
      notification: 'New request: junk removal, Didube',
      body: 'Construction debris, 3rd floor, no elevator.',
    },
    {
      emoji: '🏗️',
      notification: 'New request: bucket lift, Saburtalo',
      body: 'Deliver material to the 6th floor through the window.',
    },
  ],
};
