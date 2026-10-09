// Начальное содержимое страниц под рекламу и поиск (/s/<slug>). Записывается в базу один раз
// (landingPage.service ensureSeeded); дальше страницы живут в базе и правятся в /admin/landings,
// поэтому правка этого файла уже созданные страницы не меняет.
//
// Страница — это задача заказчика (его поисковый запрос), а не вид исполнителя. Адрес — запрос
// латиницей, заголовок повторяет запрос слово в слово.
// Тексты первого экрана: фразу «пост в группе … и выберите предложение» и две строки под формой
// владелец согласовал 2026-10-09 на грузинском. Статьи описывают настоящий порядок работы и не
// обещают цену и скорость (docs/copy-and-cognitive-load.md, принцип 4).
// Грузинский текст носитель языка не вычитывал, поэтому грузинские статьи выключены (article_on).
// В квадратных скобках — часть фразы, которую экран выделяет; {count} — число исполнителей.

const SHARED = {
  ka: { choose: 'და აირჩიეთ თქვენთვის მისაღები შეთავაზება.', fact1: 'უფასოა', fact2: 'დაინტერესებულები თავად დაგიკავშირდებიან' },
  ru: { choose: 'и выберите подходящее вам предложение.', fact1: 'Бесплатно', fact2: 'Заинтересованные сами свяжутся с вами' },
  en: { choose: 'and pick the offer that suits you.', fact1: 'Free', fact2: 'Those interested get in touch with you' },
};

// Конец статьи одинаков для всех задач: сколько стоит заказчику и кто увидит номер.
const TAIL = {
  ka: `## რა ღირს ეს დამკვეთისთვის
განაცხადის განთავსება უფასოა. თქვენ მხოლოდ შემსრულებელს უხდით სამუშაოში — იმდენს, რამდენზეც შეთანხმდით. განაცხადების მიღებისთვის პლატფორმას შემსრულებლები უხდიან.

## ვინ ნახავს თქვენს ნომერს
მხოლოდ ის შემსრულებლები, რომლებსაც თქვენი განაცხადი გაეგზავნათ. როცა შემსრულებელს იპოვით, დახურეთ განაცხადი SMS-ში მოსული ბმულით — ახალი შემსრულებლები მას აღარ მიიღებენ.`,
  ru: `## Сколько это стоит заказчику
Разместить заявку бесплатно. Вы платите только исполнителю за работу — столько, на сколько договорились. За получение заявок платформе платят исполнители.

## Кто увидит ваш номер
Только исполнители, которым отправлена ваша заявка. Когда исполнитель найден, закройте заявку по ссылке из SMS — новые исполнители её больше не получат.`,
  en: `## What it costs the customer
Posting a request is free. You pay only the provider for the work — the amount you agreed on. Providers pay the platform for receiving requests.

## Who sees your number
Only the providers your request was sent to. Once you have found a provider, close the request using the link from the SMS — no new providers will receive it.`,
};

const page = (slug, admin_name, categories, sort_order, content) => ({
  slug, admin_name, categories, sort_order,
  content: Object.fromEntries(Object.entries(content).map(([lang, text]) => [lang, {
    ...SHARED[lang], ...text, article: text.article.trim() + '\n\n' + TAIL[lang], article_on: lang !== 'ka',
  }])),
});

module.exports = [
  page('avejis-gadazidva', 'Мебель и переезд', ['movers', 'transport'], 10, {
    ka: {
      title: 'ავეჯის გადაზიდვა', accent: 'თბილისში',
      post: 'დადეთ პოსტი [{count} მუშისა და მძღოლის] ჯგუფში',
      post_plain: 'დადეთ პოსტი [მუშებისა და მძღოლების] ჯგუფში',
      placeholder: 'მაგალითად: დივანი და 10 ყუთი, საბურთალო → ვაკე, შაბათს. 80 ლარამდე.',
      seo_title: 'ავეჯის გადაზიდვა თბილისში — მუშები და მანქანა | xtender.ge',
      seo_description: 'აღწერეთ გადაზიდვა ერთხელ — განაცხადს თბილისის მუშები და მძღოლები მიიღებენ, დაინტერესებულები თავად დაგიკავშირდებიან. შეადარეთ შეთავაზებები. განთავსება უფასოა.',
      article: `
## როგორ მუშაობს
- წერთ, რა გაქვთ გადასაზიდი, საიდან და სად, როდის და რა ფასად.
- მოდერატორი ამოწმებს განაცხადს და უგზავნის მუშებსა და მძღოლებს, რომლებიც თბილისში მუშაობენ.
- დაინტერესებული შემსრულებლები თავად დაგიკავშირდებიან.
- ადარებთ შეთავაზებებს და ირჩევთ. ფასსა და დროზე უშუალოდ შემსრულებელთან თანხმდებით.

## რით განსხვავდება განცხადებაზე დარეკვისგან
ერთი ზარი — ერთი ფასია ერთი ბრიგადისგან. შესადარებლად რამდენიმესთან უნდა დარეკოთ და ყველას თავიდან აუხსნათ. აქ გადაზიდვას ერთხელ აღწერთ, პასუხობენ ისინი, ვინც საჭირო დღეს თავისუფალია და ვისაც თქვენი პირობები აწყობს.

## რა დაწეროთ განაცხადში
- რას გადაზიდავთ: ავეჯი, ტექნიკა, რამდენი ყუთი.
- საიდან და სად: უბანი ან ქუჩა.
- სართული და ლიფტი ორივე მისამართზე.
- გჭირდებათ თუ არა მუშები, ავეჯის დაშლა და აწყობა.
- დღე და მოსახერხებელი დრო.
- ბიუჯეტი, თუ იცით. ფოტო შემსრულებელს მოცულობის შეფასებაში ეხმარება.

## რაზეა დამოკიდებული ფასი
ფასს შემსრულებელთან ათანხმებთ და სხვადასხვა შემსრულებელთან ის განსხვავებულია. ჩვეულებრივ მასზე მოქმედებს ნივთების რაოდენობა, სართული და ლიფტი, მანძილი, მუშების რაოდენობა და სასწრაფოობა. რაც უფრო ზუსტია აღწერა, მით უფრო ზუსტ პასუხს მიიღებთ.`,
    },
    ru: {
      title: 'Перевозка мебели и переезды', accent: 'в Тбилиси',
      post: 'Разместите пост в группе из [{count} грузчиков и водителей]',
      post_one: 'Разместите пост в группе из [{count} грузчика и водителя]',
      post_plain: 'Разместите пост в группе [грузчиков и водителей]',
      placeholder: 'Например: диван и 10 коробок, Сабуртало → Ваке, в субботу. До 80 лари.',
      seo_title: 'Перевозка мебели и переезды в Тбилиси — грузчики и машина | xtender.ge',
      seo_description: 'Опишите переезд один раз — заявку получат грузчики и водители Тбилиси, заинтересованные свяжутся с вами сами. Сравните предложения. Размещение бесплатно.',
      article: `
## Как это работает
- Вы пишете, что нужно перевезти, откуда и куда, когда и какую сумму готовы заплатить.
- Модератор проверяет заявку и отправляет её грузчикам и водителям, которые работают в Тбилиси.
- Заинтересованные исполнители сами связываются с вами.
- Вы сравниваете предложения и выбираете. Цену и время согласуете напрямую с исполнителем.

## Чем это отличается от звонка по объявлению
Один звонок — это одна цена от одной бригады. Чтобы сравнить, приходится обзванивать нескольких и каждому заново объяснять задачу. Здесь вы описываете переезд один раз, а отвечают те, кто свободен в нужный день и согласен с вашими условиями.

## Что написать в заявке
- Что перевозим: мебель, технику, сколько коробок.
- Откуда и куда: район или улица.
- Этажи и лифт на обоих адресах.
- Нужны ли грузчики, разборка и сборка мебели.
- День и удобное время.
- Бюджет, если он у вас есть. Фото помогает исполнителю понять объём.

## От чего зависит цена
Цену вы обсуждаете с исполнителем, и у разных исполнителей она разная. Обычно на неё влияют объём вещей, этажи и лифт, расстояние, число грузчиков и срочность. Чем точнее описание, тем точнее вам ответят.`,
    },
    en: {
      title: 'Furniture moving', accent: 'in Tbilisi',
      // Запрос грузинскими словами в латинице: реклама по грузинским запросам ведёт на эту версию.
      query: 'Avejis gadazidva, mushebi',
      post: 'Post to a group of [{count} movers and drivers]',
      post_plain: 'Post to a group of [movers and drivers]',
      placeholder: 'Example: a sofa and 10 boxes, Saburtalo → Vake, on Saturday. Up to 80 GEL.',
      seo_title: 'Furniture moving in Tbilisi — movers and a van | xtender.ge',
      seo_description: 'Describe your move once: movers and drivers in Tbilisi receive the request and those interested contact you. Compare offers. Posting is free.',
      article: `
## How it works
- You write what needs moving, from where to where, when, and how much you are ready to pay.
- A moderator checks the request and sends it to movers and drivers who work in Tbilisi.
- Those interested contact you themselves.
- You compare the offers and choose. You agree on the cost and the time directly with the provider.

## How this differs from calling an ad
One call gives you one quote from one crew. To compare, you have to call several and explain the job again each time. Here you describe the move once, and the replies come from those who are free on your day and fine with your terms.

## What to write in the request
- What is being moved: furniture, appliances, how many boxes.
- From where to where: district or street.
- Floors and lifts at both addresses.
- Whether you need movers, and furniture taken apart and put together.
- The day and a convenient time.
- Your budget, if you have one. A photo helps the provider judge the volume.

## What the cost depends on
You agree on the cost with the provider, and it differs from one provider to another. It usually depends on the volume, the floors and lifts, the distance, the number of movers and the urgency. The more exact the description, the more exact the replies.`,
    },
  }),

  page('tvirtis-gadazidva', 'Перевозка груза', ['transport'], 20, {
    ka: {
      title: 'ტვირთის გადაზიდვა', accent: 'თბილისში',
      post: 'დადეთ პოსტი [{count} მძღოლის] ჯგუფში',
      post_plain: 'დადეთ პოსტი [მძღოლების] ჯგუფში',
      placeholder: 'მაგალითად: 20 ტომარა ცემენტი, დიღომი → გლდანი, ხვალ დილით. 60 ლარამდე.',
      seo_title: 'ტვირთის გადაზიდვა თბილისში — სატვირთო მანქანა მძღოლით | xtender.ge',
      seo_description: 'აღწერეთ ტვირთი ერთხელ — განაცხადს თბილისის მძღოლები მიიღებენ, დაინტერესებულები თავად დაგიკავშირდებიან. შეადარეთ შეთავაზებები. განთავსება უფასოა.',
      article: `
## როგორ მუშაობს
- წერთ, რა ტვირთი გაქვთ გადასაზიდი, საიდან და სად, როდის და რა ფასად.
- მოდერატორი ამოწმებს განაცხადს და უგზავნის მძღოლებს, რომელთა მანქანაც შეესაბამება.
- დაინტერესებული მძღოლები თავად დაგიკავშირდებიან.
- ადარებთ შეთავაზებებს და ირჩევთ.

## რა ტვირთი გადააქვთ
სამშენებლო მასალები, ავეჯი და ტექნიკა, მაღაზიის საქონელი, ნივთები გადასვლისას. მძღოლებს სხვადასხვა მანქანა ჰყავთ: პატარა ფურგონიდან გრძელ და ბორტიან მანქანამდე. დაწერეთ ტვირთის ზომა და წონა — განაცხადს მიიღებენ ისინი, ვისი მანქანაც შეესაბამება.

## რა დაწეროთ განაცხადში
- რა ტვირთია: წონა, ზომა, რაოდენობა.
- საიდან და სად.
- გჭირდებათ დატვირთვა და გადმოტვირთვა თუ მხოლოდ მანქანა.
- დახურული ძარა თუ ბორტიანი.
- დღე და დრო.
- ბიუჯეტი, თუ იცით.

## რაზეა დამოკიდებული ფასი
ფასს მძღოლთან ათანხმებთ და სხვადასხვა მძღოლთან ის განსხვავებულია. ჩვეულებრივ მასზე მოქმედებს ტვირთის მოცულობა და წონა, მანქანის ზომა, მანძილი, დატვირთვა და სასწრაფოობა. რაც უფრო ზუსტია აღწერა, მით უფრო ზუსტ პასუხს მიიღებთ.`,
    },
    ru: {
      title: 'Перевозка грузов', accent: 'в Тбилиси',
      post: 'Разместите пост в группе из [{count} водителей]',
      post_one: 'Разместите пост в группе из [{count} водителя]',
      post_plain: 'Разместите пост в группе [водителей]',
      placeholder: 'Например: 20 мешков цемента, Дигоми → Глдани, завтра утром. До 60 лари.',
      seo_title: 'Перевозка грузов в Тбилиси — грузовая машина с водителем | xtender.ge',
      seo_description: 'Опишите груз один раз — заявку получат водители Тбилиси, заинтересованные свяжутся с вами сами. Сравните предложения. Размещение бесплатно.',
      article: `
## Как это работает
- Вы пишете, какой груз нужно перевезти, откуда и куда, когда и какую сумму готовы заплатить.
- Модератор проверяет заявку и отправляет её водителям с подходящими машинами.
- Заинтересованные водители сами связываются с вами.
- Вы сравниваете предложения и выбираете.

## Какие грузы перевозят
Стройматериалы, мебель и технику, товар для магазина, вещи при переезде. У водителей разные машины: от небольшого фургона до длинной и бортовой. Напишите размеры и вес груза — заявку получат те, чья машина подходит.

## Что написать в заявке
- Что за груз: вес, размеры, количество.
- Откуда и куда.
- Нужна ли погрузка и разгрузка или только машина.
- Закрытый кузов или бортовой.
- День и время.
- Бюджет, если он у вас есть.

## От чего зависит цена
Цену вы обсуждаете с водителем, и у разных водителей она разная. Обычно на неё влияют объём и вес груза, размер машины, расстояние, погрузка и срочность. Чем точнее описание, тем точнее вам ответят.`,
    },
    en: {
      title: 'Cargo transport', accent: 'in Tbilisi',
      post: 'Post to a group of [{count} drivers]',
      post_plain: 'Post to a group of [drivers]',
      placeholder: 'Example: 20 bags of cement, Digomi → Gldani, tomorrow morning. Up to 60 GEL.',
      seo_title: 'Cargo transport in Tbilisi — a van or truck with a driver | xtender.ge',
      seo_description: 'Describe your cargo once: drivers in Tbilisi receive the request and those interested contact you. Compare offers. Posting is free.',
      article: `
## How it works
- You write what cargo needs moving, from where to where, when, and how much you are ready to pay.
- A moderator checks the request and sends it to drivers with suitable vehicles.
- Interested drivers contact you themselves.
- You compare the offers and choose.

## What cargo is carried
Building materials, furniture and appliances, goods for a shop, belongings during a move. Drivers have different vehicles, from a small van to a long or flatbed truck. Write the size and weight of the cargo — the request goes to those whose vehicle fits.

## What to write in the request
- What the cargo is: weight, size, quantity.
- From where to where.
- Whether you need loading and unloading or the vehicle only.
- Closed body or flatbed.
- The day and time.
- Your budget, if you have one.

## What the cost depends on
You agree on the cost with the driver, and it differs from one driver to another. It usually depends on the volume and weight of the cargo, the size of the vehicle, the distance, loading and the urgency. The more exact the description, the more exact the replies.`,
    },
  }),

  page('samsheneblo-nagvis-gatana', 'Вывоз строительного мусора', ['junk'], 30, {
    ka: {
      title: 'სამშენებლო ნაგვის გატანა', accent: 'თბილისში',
      post: 'დადეთ პოსტი [{count} შემსრულებლის] ჯგუფში',
      post_plain: 'დადეთ პოსტი [შემსრულებლების] ჯგუფში',
      placeholder: 'მაგალითად: სამშენებლო ნაგავი, 15 ტომარა, საბურთალო, მე-3 სართული, ხვალ. 100 ლარამდე.',
      seo_title: 'სამშენებლო ნაგვის გატანა თბილისში | xtender.ge',
      seo_description: 'აღწერეთ, რა ნაგავია გასატანი — განაცხადს თბილისის შემსრულებლები მიიღებენ, დაინტერესებულები თავად დაგიკავშირდებიან. შეადარეთ შეთავაზებები. განთავსება უფასოა.',
      article: `
## როგორ მუშაობს
- წერთ, რა ნაგავია გასატანი, რამდენია, საიდან და როდის.
- მოდერატორი ამოწმებს განაცხადს და უგზავნის შემსრულებლებს, რომლებიც ნაგვის გატანაზე მუშაობენ.
- დაინტერესებული შემსრულებლები თავად დაგიკავშირდებიან.
- ადარებთ შეთავაზებებს და ირჩევთ.

## რა გააქვთ
რემონტის შემდეგ დარჩენილი სამშენებლო ნაგავი ტომრებით ან ნაყარად, ძველი ავეჯი, კარები და ფანჯრები, საყოფაცხოვრებო ტექნიკა. დაწერეთ, გჭირდებათ თუ არა ნაგვის ბინიდან ჩამოტანა — ეს ფასზე მოქმედებს.

## რა დაწეროთ განაცხადში
- რა ნაგავია და რამდენი: ტომრები, კუბური მეტრი ან „ოთახი რემონტის შემდეგ“.
- მისამართი, სართული და არის თუ არა ლიფტი.
- ნაგავი ბინიდან უნდა ჩამოიტანონ თუ უკვე ქუჩაშია.
- დღე და დრო.
- ბიუჯეტი, თუ იცით. ფოტო მოცულობის შეფასებაში ეხმარება.

## რაზეა დამოკიდებული ფასი
ფასს შემსრულებელთან ათანხმებთ და სხვადასხვა შემსრულებელთან ის განსხვავებულია. ჩვეულებრივ მასზე მოქმედებს ნაგვის მოცულობა, სართული და ჩამოტანა, ნაგვის სახეობა და სასწრაფოობა. რაც უფრო ზუსტია აღწერა, მით უფრო ზუსტ პასუხს მიიღებთ.`,
    },
    ru: {
      title: 'Вывоз строительного мусора', accent: 'в Тбилиси',
      post: 'Разместите пост в группе из [{count} исполнителей]',
      post_one: 'Разместите пост в группе из [{count} исполнителя]',
      post_plain: 'Разместите пост в группе [исполнителей]',
      placeholder: 'Например: строительный мусор, 15 мешков, Сабуртало, 3 этаж, завтра. До 100 лари.',
      seo_title: 'Вывоз строительного мусора в Тбилиси | xtender.ge',
      seo_description: 'Опишите, какой мусор нужно вывезти, — заявку получат исполнители Тбилиси, заинтересованные свяжутся с вами сами. Сравните предложения. Размещение бесплатно.',
      article: `
## Как это работает
- Вы пишете, какой мусор нужно вывезти, сколько его, откуда и когда.
- Модератор проверяет заявку и отправляет её исполнителям, которые занимаются вывозом мусора.
- Заинтересованные исполнители сами связываются с вами.
- Вы сравниваете предложения и выбираете.

## Что вывозят
Строительный мусор после ремонта в мешках и россыпью, старую мебель, двери и окна, бытовую технику. Напишите, нужно ли выносить мусор из квартиры: это влияет на цену.

## Что написать в заявке
- Что за мусор и сколько: мешки, кубометры или «комната после ремонта».
- Адрес, этаж и есть ли лифт.
- Нужно ли выносить из квартиры или мусор уже на улице.
- День и время.
- Бюджет, если он у вас есть. Фото помогает оценить объём.

## От чего зависит цена
Цену вы обсуждаете с исполнителем, и у разных исполнителей она разная. Обычно на неё влияют объём мусора, этаж и вынос, вид мусора и срочность. Чем точнее описание, тем точнее вам ответят.`,
    },
    en: {
      title: 'Construction waste removal', accent: 'in Tbilisi',
      post: 'Post to a group of [{count} providers]',
      post_plain: 'Post to a group of [providers]',
      placeholder: 'Example: construction waste, 15 bags, Saburtalo, 3rd floor, tomorrow. Up to 100 GEL.',
      seo_title: 'Construction waste removal in Tbilisi | xtender.ge',
      seo_description: 'Describe the waste that needs removing: providers in Tbilisi receive the request and those interested contact you. Compare offers. Posting is free.',
      article: `
## How it works
- You write what waste needs removing, how much there is, from where and when.
- A moderator checks the request and sends it to providers who do waste removal.
- Those interested contact you themselves.
- You compare the offers and choose.

## What is removed
Construction waste after a renovation, in bags or loose, old furniture, doors and windows, household appliances. Say whether the waste has to be carried out of the flat: it affects the cost.

## What to write in the request
- What the waste is and how much: bags, cubic metres or “a room after renovation”.
- The address, the floor and whether there is a lift.
- Whether it has to be carried out of the flat or is already outside.
- The day and time.
- Your budget, if you have one. A photo helps to judge the volume.

## What the cost depends on
You agree on the cost with the provider, and it differs from one provider to another. It usually depends on the volume of waste, the floor and carrying, the kind of waste and the urgency. The more exact the description, the more exact the replies.`,
    },
  }),
];
