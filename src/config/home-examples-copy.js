// Данные для карусели "живых примеров" на главной (см. home-examples в i18n.js).
// Каждый пример — один запрос клиента + несколько РАЗНЫХ мастеров, ответивших
// своим предложением (это и есть суть сервиса: одна заявка → разные условия).
// Категории — реальные (см. src/config/serviceTypes.js), выдуманных нет.
module.exports = {
  ka: [
    {
      emoji: '🧹',
      request: 'საჭიროა სამშენებლო ნაგვის გატანა (15 ტომარა) საბურთალოდან.',
      responses: [
        { name: 'დათო', text: '1 საათში მანდ ვარ, ჩემით ჩამოვიტან — 100 ₾.' },
        { name: 'გიო', text: 'საღამოს მცალია, ფორდ ტრანზიტით — 70 ₾ (მუშების გარეშე).' },
      ],
    },
    {
      emoji: '🧹',
      request: 'სარემონტო ნაგვის გატანაა საჭირო — სამი ოთახი, სარდაფი.',
      responses: [
        { name: 'ირაკლი', text: 'დიდი მანქანით ერთბაშად წავიღებ — 220 ₾, დღეს საღამოს.' },
        { name: 'ვახო', text: 'ორნი ვართ, სწრაფად დავასრულებთ — 250 ₾, ხვალ დილით.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'გადასახლება: ვაკედან საბურთალომდე, დივანი და კარადა, მე-5 სართული, ლიფტის გარეშე.',
      responses: [
        { name: 'ლევანი', text: 'ლიფტის გარეშეც გავართმევ თავს — 180 ₾, ხვალ დილით ვარ თავისუფალი.' },
        { name: 'ბექა', text: 'დღესვე მოვალ, ორი მუშითურთ — 210 ₾.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'გადასახლება: დიდუბედან ისანამდე, მხოლოდ ყუთები და მაცივარი.',
      responses: [
        { name: 'სანდრო', text: 'საათში დავასრულებთ, პატარა მანქანით — 90 ₾, ახლავე თავისუფალი ვარ.' },
        { name: 'თორნიკე', text: 'საღამოს 6 საათზე შემიძლია — 80 ₾.' },
      ],
    },
    {
      emoji: '💪',
      request: 'საჭიროა 20 ფურცელი გიფსკარტონის ატანა მე-8 სართულზე, ლიფტის გარეშე.',
      responses: [
        { name: 'გიორგი', text: 'ორნი ავწევთ საათში, ლიფტი არ გვჭირდება — 70 ₾.' },
        { name: 'ნიკა', text: 'სამნი — უფრო სწრაფად, 90 ₾, დღეს საღამოს.' },
      ],
    },
    {
      emoji: '💪',
      request: 'კარადის დაშლა და ახალ ადგილას აწყობა — იმავე დღეს.',
      responses: [
        { name: 'ოთარი', text: 'დღეს 3 საათზე, ხელსაწყოები მაქვს — 60 ₾.' },
        { name: 'ზაზა', text: 'ორ საათში ვასრულებ — 50 ₾, ახლავე თავისუფალი ვარ.' },
      ],
    },
    {
      emoji: '🛻',
      request: 'მანქანა არ ირთვება ვაკეში — ევაკუატორი მჭირდება.',
      responses: [
        { name: 'თენგიზი', text: 'ახლავე გამოვდივარ, 20 წუთში ვიქნები — 60 ₾.' },
        { name: 'დათო', text: 'თავისუფალი ვარ, 15 წუთში მოვალ — 70 ₾.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'სარემონტოდ ავტოამწე მჭირდება, მე-6 სართული, მასალის ფანჯრიდან ატანა.',
      responses: [
        { name: 'ირაკლი', text: 'საღამოს თავისუფალი ვარ — ფასი სართულზეა დამოკიდებული, დაახლოებით 120 ₾.' },
        { name: 'ვახო', text: 'ხვალ დილით შემიძლია — 100 ₾.' },
      ],
    },
  ],
  ru: [
    {
      emoji: '🧹',
      request: 'Нужно вывезти строймусор (15 мешков) из Сабуртало.',
      responses: [
        { name: 'Дато', text: 'Буду через час, сам всё вынесу — 100 ₾.' },
        { name: 'Гио', text: 'Есть свободная Газель на вечер — 70 ₾ (без грузчиков).' },
      ],
    },
    {
      emoji: '🧹',
      request: 'Мусор после ремонта — три комнаты, подвал.',
      responses: [
        { name: 'Ираклий', text: 'Заберу всё за раз, большая машина — 220 ₾, сегодня вечером.' },
        { name: 'Вахо', text: 'Нас двое, управимся быстро — 250 ₾, завтра утром.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'Переезд: Ваке → Сабуртало, диван и шкаф, 5 этаж без лифта.',
      responses: [
        { name: 'Леван', text: 'Без лифта тоже справлюсь — 180 ₾, свободен завтра утром.' },
        { name: 'Бека', text: 'Приеду сегодня с двумя грузчиками — 210 ₾.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'Переезд: Дидубе → Исани, только коробки и холодильник.',
      responses: [
        { name: 'Сандро', text: 'За час управимся, маленькая машина — 90 ₾, свободен прямо сейчас.' },
        { name: 'Торнике', text: 'Могу в 6 вечера — 80 ₾.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Нужно поднять 20 листов гипсокартона на 8 этаж, без лифта.',
      responses: [
        { name: 'Гиорги', text: 'Вдвоём поднимем за час, лифт не нужен — 70 ₾.' },
        { name: 'Ника', text: 'Втроём — быстрее, 90 ₾, сегодня вечером.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Разобрать шкаф и собрать на новом месте — в тот же день.',
      responses: [
        { name: 'Отар', text: 'Сегодня в 3 часа, инструменты с собой — 60 ₾.' },
        { name: 'Заза', text: 'Управлюсь за два часа — 50 ₾, свободен прямо сейчас.' },
      ],
    },
    {
      emoji: '🛻',
      request: 'Машина не заводится в Ваке — нужен эвакуатор.',
      responses: [
        { name: 'Тенгиз', text: 'Выезжаю сейчас, буду через 20 минут — 60 ₾.' },
        { name: 'Дато', text: 'Свободен, буду через 15 минут — 70 ₾.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'Нужна автовышка для ремонта, 6 этаж, подать материал в окно.',
      responses: [
        { name: 'Ираклий', text: 'Свободен сегодня вечером — цена от этажа, около 120 ₾.' },
        { name: 'Вахо', text: 'Могу завтра утром — 100 ₾.' },
      ],
    },
  ],
  en: [
    {
      emoji: '🧹',
      request: 'Need construction debris removed (15 bags) from Saburtalo.',
      responses: [
        { name: 'Dato', text: "There in an hour, I'll load it myself — 100 ₾." },
        { name: 'Gio', text: 'Have a van free this evening — 70 ₾ (no movers).' },
      ],
    },
    {
      emoji: '🧹',
      request: 'Renovation debris removal — three rooms, basement floor.',
      responses: [
        { name: 'Irakli', text: "I'll take it all in one trip, big truck — 220 ₾, this evening." },
        { name: 'Vakho', text: "There's two of us, we'll be quick — 250 ₾, tomorrow morning." },
      ],
    },
    {
      emoji: '🚚',
      request: 'Move: Vake to Saburtalo, a sofa and a wardrobe, 5th floor, no elevator.',
      responses: [
        { name: 'Levan', text: 'No elevator, no problem — 180 ₾, free tomorrow morning.' },
        { name: 'Beka', text: 'I can come today with two movers — 210 ₾.' },
      ],
    },
    {
      emoji: '🚚',
      request: 'Move: Didube to Isani, just boxes and a fridge.',
      responses: [
        { name: 'Sandro', text: "We'll be done in an hour, small truck — 90 ₾, free right now." },
        { name: 'Tornike', text: 'I can do 6pm — 80 ₾.' },
      ],
    },
    {
      emoji: '💪',
      request: 'Need to carry 20 sheets of drywall to the 8th floor, no elevator.',
      responses: [
        { name: 'Giorgi', text: 'Two of us, done within the hour, no elevator needed — 70 ₾.' },
        { name: 'Nika', text: "Three of us — faster, 90 ₾, this evening." },
      ],
    },
    {
      emoji: '💪',
      request: 'Disassemble a wardrobe and reassemble it at the new place — same day.',
      responses: [
        { name: 'Otar', text: 'Today at 3, I have the tools — 60 ₾.' },
        { name: 'Zaza', text: "Done in two hours — 50 ₾, free right now." },
      ],
    },
    {
      emoji: '🛻',
      request: "Car won't start in Vake — need a tow truck.",
      responses: [
        { name: 'Tengiz', text: 'Heading out now, there in 20 minutes — 60 ₾.' },
        { name: 'Dato', text: 'Free now, there in 15 minutes — 70 ₾.' },
      ],
    },
    {
      emoji: '🏗️',
      request: 'Need a bucket lift for renovation, 6th floor, passing material through the window.',
      responses: [
        { name: 'Irakli', text: 'Free this evening — depends on the floor, around 120 ₾.' },
        { name: 'Vakho', text: 'I can do tomorrow morning — 100 ₾.' },
      ],
    },
  ],
};
