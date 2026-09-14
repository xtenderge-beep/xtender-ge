// Данные для карусели "живых примеров" на главной (см. home-examples в i18n.js).
// Каждый пример — один запрос клиента + несколько РАЗНЫХ мастеров, ответивших
// своим предложением (это и есть суть сервиса: одна заявка → разные условия).
// Категории — реальные (см. src/config/serviceTypes.js), выдуманных нет.
module.exports = {
  ka: [
    {
      emoji: '🧹',
      request: 'საჭიროა ნაგვის გატანა — ერთი ოთახის მოცულობა, მე-3 სართული, ლიფტის გარეშე.',
      responses: [
        { name: 'დათო', text: 'თავისუფალი ვარ, ლიფტის გარეშეც ჩამოვიტან — საღამომდე, 90 ლარი.' },
        { name: 'გიო', text: 'შემიძლია ხვალ დილით, მანქანა მაქვს — 75 ლარი.' },
      ],
    },
    {
      emoji: '🧹',
      request: 'სარემონტო ნაგვის გატანაა საჭირო — სამი ოთახი, მიწისქვეშა სართული.',
      responses: [
        { name: 'ირაკლი', text: 'დიდი მანქანა მაქვს, ერთ ჯერზე ავიღებ — 220 ლარი, დღეს საღამოს.' },
        { name: 'ვახო', text: 'ორნი ვართ, სწრაფად დავასრულებთ — 250 ლარი, ხვალ დილით.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'გადასახლება მჭირდება: ვაკედან საბურთალომდე, 2-ოთახიანი ბინა, დივანი და კარადა, მე-5 სართული, ლიფტის გარეშე.',
      responses: [
        { name: 'ლევანი', text: 'ლიფტის გარეშეც ვმართავ, მანქანა 12 კუბი, ხვალ დილით თავისუფალი ვარ — 180 ლარი.' },
        { name: 'ბექა', text: 'დღესვე შემიძლია, ორი მუშაც მეყოლება — 210 ლარი.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'გადასახლება მჭირდება: დიდუბიდან ისანამდე, პატარა ბინა, მხოლოდ ყუთები და მაცივარი.',
      responses: [
        { name: 'სანდრო', text: 'პატარა მანქანით გავალ, საათში დავასრულებთ — 90 ლარი, ახლავე თავისუფალი ვარ.' },
        { name: 'თორნიკე', text: 'შემიძლია საღამოს 6 საათზე — 80 ლარი.' },
      ],
    },
    {
      emoji: '💪',
      request: 'საჭიროა 20 ფურცელი გიფსკარტონის ატანა მე-8 სართულზე, ლიფტის გარეშე.',
      responses: [
        { name: 'გიორგი', text: 'ავწევთ, ორნი ვართ — ლიფტის გარეშეც შევძლებთ, საათში მოვალთ, 70 ლარი.' },
        { name: 'ნიკა', text: 'სამი კაცით სწრაფად დავასრულებთ — 90 ლარი, დღეს საღამოს.' },
      ],
    },
    {
      emoji: '💪',
      request: 'საჭიროა კარადის დაშლა და ახალ ბინაში აწყობა, იმავე დღეს.',
      responses: [
        { name: 'ოთარი', text: 'შემიძლია დღეს 3 საათზე, ხელსაწყოები მაქვს — 60 ლარი.' },
        { name: 'ზაზა', text: 'ორ საათში ვასრულებ — 50 ლარი, ახლავე თავისუფალი ვარ.' },
      ],
    },
    {
      emoji: '🛻',
      request: 'მანქანა გამიფუჭდა ვაკეში, არ ირთვება — ევაკუატორი მჭირდება.',
      responses: [
        { name: 'თენგიზი', text: 'ახლავე გამოვდივარ, 20 წუთში ვიქნები — 60 ლარი.' },
        { name: 'დათო', text: 'თავისუფალი ვარ, 15 წუთში მოვალ — 70 ლარი.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'სარემონტოდ ავტოამწე მჭირდება, მე-6 სართული, მასალის ფანჯრიდან ატანა.',
      responses: [
        { name: 'ირაკლი', text: 'საღამოს თავისუფალი ვარ — ფასი სართულზეა დამოკიდებული, დაახლოებით 120 ლარი.' },
        { name: 'ვახო', text: 'ხვალ დილით შემიძლია — 100 ლარი.' },
      ],
    },
  ],
  ru: [
    {
      emoji: '🧹',
      request: 'Нужно вывезти мусор — объём одной комнаты, 3 этаж, без лифта.',
      responses: [
        { name: 'Дато', text: 'Свободен, вынесу и без лифта — до вечера, 90 лари.' },
        { name: 'Гио', text: 'Могу завтра утром, машина есть — 75 лари.' },
      ],
    },
    {
      emoji: '🧹',
      request: 'Нужно вывезти мусор после ремонта — три комнаты, цокольный этаж.',
      responses: [
        { name: 'Ираклий', text: 'Большая машина есть, заберу за один раз — 220 лари, сегодня вечером.' },
        { name: 'Вахо', text: 'Нас двое, управимся быстро — 250 лари, завтра утром.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'Нужен переезд: Ваке → Сабуртало, 2-комнатная квартира, диван и шкаф, 5 этаж, без лифта.',
      responses: [
        { name: 'Леван', text: 'Без лифта тоже справлюсь, машина 12 кубов, свободен завтра утром — 180 лари.' },
        { name: 'Бека', text: 'Могу сегодня же, будут два грузчика — 210 лари.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'Нужен переезд: с Дидубе на Исани, маленькая квартира, только коробки и холодильник.',
      responses: [
        { name: 'Сандро', text: 'Заеду на маленькой машине, за час управимся — 90 лари, свободен прямо сейчас.' },
        { name: 'Торнике', text: 'Могу вечером в 6 — 80 лари.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Нужно поднять 20 листов гипсокартона на 8 этаж, без лифта.',
      responses: [
        { name: 'Гиорги', text: 'Поднимем, нас двое — управимся и без лифта, приедем в течение часа, 70 лари.' },
        { name: 'Ника', text: 'Втроём поднимем быстро — 90 лари, сегодня вечером.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Нужно разобрать шкаф и собрать на новом месте, в тот же день.',
      responses: [
        { name: 'Отар', text: 'Могу сегодня в 3 часа, инструменты есть — 60 лари.' },
        { name: 'Заза', text: 'Управлюсь за два часа — 50 лари, свободен прямо сейчас.' },
      ],
    },
    {
      emoji: '🛻',
      request: 'Машина сломалась в Ваке, не заводится — нужен эвакуатор.',
      responses: [
        { name: 'Тенгиз', text: 'Выезжаю сейчас, буду через 20 минут — 60 лари.' },
        { name: 'Дато', text: 'Свободен, буду через 15 минут — 70 лари.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'Нужна автовышка для ремонта, 6 этаж, подать материал через окно.',
      responses: [
        { name: 'Ираклий', text: 'Свободен сегодня вечером — цена зависит от этажа, примерно 120 лари.' },
        { name: 'Вахо', text: 'Могу завтра утром — 100 лари.' },
      ],
    },
  ],
  en: [
    {
      emoji: '🧹',
      request: "Need junk removed — about one room's worth, 3rd floor, no elevator.",
      responses: [
        { name: 'Dato', text: "Free now, I'll carry it down myself, no elevator needed — by evening, 90 GEL." },
        { name: 'Gio', text: 'I can do tomorrow morning, I have a truck — 75 GEL.' },
      ],
    },
    {
      emoji: '🧹',
      request: "Need renovation debris removed — three rooms' worth, basement floor.",
      responses: [
        { name: 'Irakli', text: "I have a big truck, I'll take it in one trip — 220 GEL, this evening." },
        { name: 'Vakho', text: "There's two of us, we'll be quick — 250 GEL, tomorrow morning." },
      ],
    },
    {
      emoji: '🚚',
      request: 'Need to move: Vake to Saburtalo, 2-room apartment, a sofa and a wardrobe, 5th floor, no elevator.',
      responses: [
        { name: 'Levan', text: 'I can handle it without an elevator too, 12m³ truck, free tomorrow morning — 180 GEL.' },
        { name: 'Beka', text: "I can do it today, I'll bring two movers — 210 GEL." },
      ],
    },
    {
      emoji: '🚚',
      request: 'Need to move: Didube to Isani, small apartment, just boxes and a fridge.',
      responses: [
        { name: 'Sandro', text: "I'll bring a small truck, we'll be done in an hour — 90 GEL, free right now." },
        { name: 'Tornike', text: 'I can do this evening at 6 — 80 GEL.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Need to carry 20 sheets of drywall to the 8th floor, no elevator.',
      responses: [
        { name: 'Giorgi', text: "We'll carry it, two of us — no elevator, no problem, there within the hour, 70 GEL." },
        { name: 'Nika', text: "Three of us, we'll be quick — 90 GEL, this evening." },
      ],
    },
    {
      emoji: '💪',
      request: 'Need a wardrobe disassembled and reassembled at the new place, same day.',
      responses: [
        { name: 'Otar', text: 'I can do today at 3, I have the tools — 60 GEL.' },
        { name: 'Zaza', text: "I'll be done in two hours — 50 GEL, free right now." },
      ],
    },
    {
      emoji: '🛻',
      request: "Car broke down in Vake, won't start — need a tow truck.",
      responses: [
        { name: 'Tengiz', text: 'Heading out now, there in 20 minutes — 60 GEL.' },
        { name: 'Dato', text: 'Free now, there in 15 minutes — 70 GEL.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'Need a bucket lift for renovation work, 6th floor, passing material through the window.',
      responses: [
        { name: 'Irakli', text: 'Free this evening — price depends on the floor, around 120 GEL.' },
        { name: 'Vakho', text: 'I can do tomorrow morning — 100 GEL.' },
      ],
    },
  ],
};
