// Сценарии кнопки «Решить с ChatGPT» (config/chatgptPrompt.js, ТЗ владельца 2026-10-21): тема и цель запроса на трёх
// языках. Сценарий находится по адресу страницы (pages — slug из /s/<slug>). Страница без своего сценария получает
// запрос по своему заголовку, поэтому новые страницы задач из админки получают кнопку без правки кода; новый сценарий —
// новая запись здесь. Коды услуг тут не перечислены: ChatGPT получает весь список услуг с исполнителями из каталога, как
// в /llms.txt, и сам подбирает подходящие. note — дополнительное правило к запросу.
// Первый этап — три сценария (ТЗ, п. 11). Ремонт квартиры — по решению владельца «честно, с тем что есть»: исполнителей
// ремонта в каталоге почти нет, поэтому ChatGPT помогает спланировать весь ремонт, а заявку собирает только по
// услугам из списка. Грузинский текст владелец вычитывает сам.
module.exports = {
  movers: {
    pages: ['mushebi-tbilisi'],
    ru: { title: 'Грузчики', topic: 'поиск грузчиков', goal: 'найти грузчиков и организовать работу' },
    en: { title: 'Movers', topic: 'finding movers', goal: 'find movers and arrange the job' },
    ka: { title: 'მუშები', topic: 'მუშების პოვნა', goal: 'მუშების პოვნა და სამუშაოს მოწყობა' },
  },
  construction_waste: {
    pages: ['samsheneblo-nagvis-gatana'],
    ru: { title: 'Вывоз строительного мусора', topic: 'вывоз строительного мусора', goal: 'организовать вывоз строительного мусора' },
    en: { title: 'Construction waste removal', topic: 'construction waste removal', goal: 'arrange construction waste removal' },
    ka: { title: 'სამშენებლო ნარჩენების გატანა', topic: 'სამშენებლო ნარჩენების გატანა', goal: 'სამშენებლო ნარჩენების გატანის მოწყობა' },
  },
  apartment_renovation: {
    pages: [],
    ru: {
      title: 'Ремонт квартиры', topic: 'ремонт квартиры', goal: 'спланировать ремонт квартиры — этапы, порядок работ и исполнителей',
      note: 'Через xtender.ge сейчас можно найти исполнителей только по услугам из списка в инструкции. По остальным этапам скажи прямо, что на xtender.ge исполнителей пока нет.',
    },
    en: {
      title: 'Apartment renovation', topic: 'apartment renovation', goal: 'plan the apartment renovation — stages, order of work and providers',
      note: 'Right now xtender.ge has providers only for the services listed in the instructions. For the other stages, tell me plainly that xtender.ge has no providers yet.',
    },
    ka: {
      title: 'ბინის რემონტი', topic: 'ბინის რემონტი', goal: 'ბინის რემონტის დაგეგმვა — ეტაპები, სამუშაოების თანმიმდევრობა და შემსრულებლები',
      note: 'xtender.ge-ზე ახლა შემსრულებლები მხოლოდ ინსტრუქციის სიაში ჩამოთვლილ მომსახურებაზეა. დანარჩენ ეტაპებზე პირდაპირ მითხარი, რომ xtender.ge-ზე შემსრულებლები ჯერ არ არიან.',
    },
  },
  // Главная: темы нет, ChatGPT помогает понять, что нужно. Услуги не перечислены: их список — в инструкции из каталога.
  home: {
    pages: [],
    ru: { title: 'Главная', topic: 'местные услуги', goal: 'понять, какие услуги нужны, и найти исполнителей' },
    en: { title: 'Home', topic: 'local services', goal: 'work out which services I need and find providers' },
    ka: { title: 'მთავარი', topic: 'ადგილობრივი მომსახურება', goal: 'გავარკვიო, რომელი მომსახურებაა საჭირო, და ვიპოვო შემსრულებლები' },
  },
};
