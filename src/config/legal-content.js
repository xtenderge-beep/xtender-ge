// Полный текст юридических документов xtender.ge (Оферта + Политика конфиденциальности)
// на ka/ru/en. Рендерится в src/views/terms.ejs и privacy.ejs.
//
// Блоки: { h: '...' } — заголовок раздела, { p: '...' } — абзац, { ul: [...] } — список,
// { requisites: true } — таблица реквизитов из legal.js SERVICE_REQUISITES.
//
// При ЛЮБОЙ правке текста — поднять соответствующую версию в legal.js (TERMS_VERSION /
// PRIVACY_VERSION): по ней в sms_consent_logs видно, какую редакцию принял человек.
// Приоритет при расхождении языковых версий — за грузинской (см. п. 1.5).

const { TERMS_VERSION, PRIVACY_VERSION } = require('./legal');

const REQUISITE_LABELS = {
  ka: {
    heading: 'რეკვიზიტები',
    entityName: 'კომპანიის დასახელება / ინდ. მეწარმე',
    idCode: 'საიდენტიფიკაციო კოდი / პირადი ნომერი',
    legalAddress: 'იურიდიული მისამართი',
    email: 'ელექტრონული ფოსტა',
    phone: 'საკონტაქტო ტელეფონი',
    website: 'ვებ-საიტი',
  },
  ru: {
    heading: 'Реквизиты',
    entityName: 'Наименование организации / ФИО ИП',
    idCode: 'Идентификационный код / Личный номер',
    legalAddress: 'Юридический адрес',
    email: 'Электронная почта',
    phone: 'Телефон поддержки',
    website: 'Веб-сайт',
  },
  en: {
    heading: 'Details',
    entityName: 'Legal Entity Name / Individual Entrepreneur',
    idCode: 'Identification Code / Personal Number',
    legalAddress: 'Legal Address',
    email: 'E-mail',
    phone: 'Support Phone',
    website: 'Website',
  },
};

const REQUISITE_PENDING = {
  ka: 'დაზუსტდება იურიდიული პირის რეგისტრაციის დასრულების შემდეგ',
  ru: 'Уточняется после завершения регистрации юридического лица',
  en: 'To be published upon completion of legal entity registration',
};

const LABELS = {
  ka: { updated: 'ბოლო განახლება', version: 'ვერსია', tab_terms: 'საჯარო ოფერტა', tab_privacy: 'კონფიდენციალურობის პოლიტიკა' },
  ru: { updated: 'Последнее обновление', version: 'Версия', tab_terms: 'Публичная оферта', tab_privacy: 'Политика конфиденциальности' },
  en: { updated: 'Last updated', version: 'Version', tab_terms: 'Terms of Service', tab_privacy: 'Privacy Policy' },
};

// ─────────────────────────────── ОФЕРТА / TERMS ───────────────────────────────

const terms = {
  version: TERMS_VERSION,
  updated: { ka: '2026 წლის 3 სექტემბერი', ru: '3 сентября 2026 г.', en: 'September 3, 2026' },
  body: {
    ka: [
      { h: '1.1. ზოგადი დებულებები' },
      { p: '1.1.1. წინამდებარე დოკუმენტი წარმოადგენს საჯარო ოფერტას (შემდგომში — «ხელშეკრულება») პლატფორმა xtender.ge-ს (შემდგომში — «სერვისი») მხრიდან და ადგენს სერვისით სარგებლობის წესებს შემსრულებლებისთვის (მუშები, მძღოლები, ოსტატები) და დამკვეთებისთვის.' },
      { p: '1.1.2. სერვისზე რეგისტრაცია, ავტორიზაცია ერთჯერადი SMS-კოდის (OTP) შეყვანით, განცხადების განთავსება ან შეკვეთის განთავსება ითვლება ამ ხელშეკრულების სრულ და უპირობო აქცეპტად (მიღებად).' },
      { p: '1.1.3. მხარეები აღიარებენ, რომ SMS-კოდის (OTP) შეყვანა წარმოადგენს მარტივი ელექტრონული ხელმოწერის ანალოგს. OTP-კოდის შეყვანის შემდეგ განხორციელებული ყველა მოქმედება ითვლება უშუალოდ მომხმარებლის მიერ განხორციელებულად. მომხმარებელი თავად ეკისრება პასუხისმგებლობას თავისი სიმ-ბარათისა და მოწყობილობის უსაფრთხოებაზე.' },

      { h: '1.2. სერვისის სტატუსი, გადასახადები და პასუხისმგებლობის შეზღუდვა' },
      { p: '1.2.1. xtender.ge წარმოადგენს მხოლოდ საინფორმაციო-ტექნოლოგიურ პლატფორმას (საინფორმაციო შუამავალს). სერვისი არ არის დამსაქმებელი, იჯარით გამცემი, ნარდობის ხელშეკრულების მხარე, ექსპედიტორი ან საგადასახადო აგენტი.' },
      { p: '1.2.2. საგადასახადო ვალდებულებები: შემსრულებელს ეკისრება ერთპიროვნული პასუხისმგებლობა საქართველოს საგადასახადო კანონმდებლობის დაცვაზე, მათ შორის შემოსავლების დამოუკიდებლად დეკლარირებაზე, ინდივიდუალურ მეწარმედ რეგისტრაციასა (საჭიროების შემთხვევაში) და შესაბამისი გადასახადების გადახდაზე.' },
      { p: '1.2.3. ყველა ფინანსური, სახელშეკრულებო და სამართლებრივი ურთიერთობა (მათ შორის სამუშაოს ღირებულება, ვადები, ხარისხი და მომხმარებელთა უფლებების დაცვის კანონმდებლობით გათვალისწინებული პრეტენზიები) ყალიბდება უშუალოდ დამკვეთსა და შემსრულებელს შორის.' },
      { p: '1.2.4. „როგორც არის" (AS IS) და პასუხისმგებლობის უარყოფა: სერვისი მიეწოდება „როგორც არის" (AS IS) პრინციპით. სერვისი არ აგებს პასუხს:' },
      { ul: [
        'შემსრულებლის მიერ დამკვეთის ქონებისთვის მიყენებულ ზიანზე (ტვირთის დაზიანება, გაფუჭება, ნივთების გატეხა გადაზიდვისას/დატვირთვისას);',
        'შემსრულებლის მიერ სამუშაოების უხარისხოდ, არასრულად ან ვადაგადაცილებით შესრულებაზე, ან დამკვეთის მიერ თანხის გადაუხდელობაზე;',
        'პროგრამული უზრუნველყოფის დროებით ტექნიკურ შეფერხებებზე, სერვერის ხარვეზებზე ან მომხმარებელთა მიერ განთავსებული შინაარსის (კონტენტის) სინამდვილეზე.',
      ] },
      { p: '1.2.5. სერვისი იტოვებს უფლებას წინასწარი შეტყობინების გარეშე დაბლოკოს ან წაშალოს მომხმარებლების პროფილები მათ მიერ კანონმდებლობის დარღვევის, საჩივრების მიღების ან არასარწმუნო ინფორმაციის განთავსების შემთხვევაში.' },

      { h: '1.3. პერსონალური მონაცემები და უფლებების დაცვა' },
      { p: '1.3.1. მონაცემთა დამუშავება რეგულირდება ცალკეული კონფიდენციალურობის პოლიტიკით.' },
      { p: '1.3.2. შემსრულებელი რეგისტრაციისას იძლევა პირდაპირ თანხმობას მისი სახელის, ტელეფონის ნომრისა და მომსახურების აღწერილობის საჯაროდ გამოქვეყნებაზე ვებ-საიტზე xtender.ge დამკვეთებთან კომუნიკაციის მიზნით.' },
      { p: '1.3.3. შემსრულებელს უფლება აქვს ნებისმიერ დროს გამოითხოვოს თავისი თანხმობა ტელეფონის ნომრის საჯარო განთავსებაზე და მოითხოვოს პროფილისა და მონაცემთა წაშლა (უფლება დავიწყებაზე) მხარდაჭერის სამსახურში მოთხოვნის გაგზავნით.' },
      { p: '1.3.4. სერვისი ახორციელებს მხოლოდ სერვისული/ტრანზაქციული SMS-შეტყობინებების გაგზავნას (შეტყობინებები ახალ შეკვეთებზე, ბალანსის სტატუსზე, ანგარიშის მოდერაციაზე, ტარიფების ცვლილებაზე). სერვისი არ ახორციელებს სარეკლამო (მარკეტინგულ) დაგზავნებს.' },

      { h: '1.4. გამოსაყენებელი სამართალი და დავების გადაწყვეტა' },
      { p: '1.4.1. წინამდებარე ხელშეკრულება რეგულირდება და განიმარტება საქართველოს კანონმდებლობის შესაბამისად.' },
      { p: '1.4.2. სერვისით სარგებლობასთან დაკავშირებით წარმოშობილი ყველა დავა ექვემდებარება მოლაპარაკების გზით გადაწყვეტას. შეთანხმების მიუღწევლობის შემთხვევაში, დავა განსახილველად გადაეცემა საქართველოს სასამართლოებს სერვისის ადგილსამყოფელის მიხედვით.' },

      { h: '1.5. ენების პრიორიტეტი' },
      { p: '1.5.1. წინამდებარე ხელშეკრულება შედგენილია ქართულ, რუსულ და ინგლისურ ენებზე.' },
      { p: '1.5.2. ენობრივ ვერსიებს შორის რაიმე უზუსტობის ან განსხვავების აღმოჩენის შემთხვევაში, უპირობო იურიდიული პრიორიტეტი ენიჭება ქართულ ვერსიას.' },

      { h: '1.6. სერვისის რეკვიზიტები' },
      { requisites: true },
    ],
    ru: [
      { h: '1.1. Общие положения' },
      { p: '1.1.1. Настоящий документ является Публичной офертой (далее — «Договор») платформы xtender.ge (далее — «Сервис») и определяет правила использования Сервиса Исполнителями (грузчиками, водителями, мастерами) и Заказчиками.' },
      { p: '1.1.2. Регистрация на Сервисе, авторизация путем ввода одноразового SMS-кода (OTP), публикация объявления или создание заявки является полным и безоговорочным акцептом настоящего Договора.' },
      { p: '1.1.3. Стороны признают, что ввод одноразового SMS-кода (OTP) является аналогом простой электронной подписи. Все действия, совершенные после ввода OTP-кода, считаются совершенными непосредственно Пользователем. Пользователь несет личную ответственность за сохранность своей SIM-карты и устройства.' },

      { h: '1.2. Статус Сервиса, налоги и ограничение ответственности' },
      { p: '1.2.1. xtender.ge является исключительно информационно-технологической платформой (информационным посредником). Сервис не является работодателем, подрядчиком, агентом, экспедитором или налоговым агентом.' },
      { p: '1.2.2. Налоговые обязательства: Исполнитель несет единоличную ответственность за соблюдение налогового законодательства Грузии, включая самостоятельное декларирование доходов, регистрацию в качестве индивидуального предпринимателя (при необходимости) и уплату соответствующих налогов.' },
      { p: '1.2.3. Все финансовые, договорные и правовые отношения (включая стоимость, сроки, качество работ и претензии по Закону Грузии «О защите прав потребителей») возникают напрямую между Заказчиком и Исполнителем.' },
      { p: '1.2.4. Принцип «Как есть» (AS IS) и отказ от ответственности: Сервис предоставляется на условиях «как есть» (AS IS). Сервис не несет ответственности:' },
      { ul: [
        'За любой материальный ущерб, причиненный Исполнителем имуществу Заказчика (повреждение, порча груза или вещей при погрузке/перевозке);',
        'За некачественное, неполное или несвоевременное выполнение работ Исполнителем, а также за неоплату работ Заказчиком;',
        'За технические сбои в работе программного обеспечения, перерывы в работе серверов и недостоверность контента, размещенного пользователями.',
      ] },
      { p: '1.2.5. Сервис оставляет за собой право без предварительного уведомления блокировать или удалять профили пользователей в случае нарушения ими законодательства, поступления жалоб или публикации недостоверной информации.' },

      { h: '1.3. Персональные данные и право на отзыв' },
      { p: '1.3.1. Обработка персональных данных регулируется отдельным документом — Политикой конфиденциальности.' },
      { p: '1.3.2. Регистрируясь в качестве Исполнителя, Пользователь дает прямое согласие на публичное размещение своего имени, номера телефона и описания услуг на сайте xtender.ge для целей связи с ним Заказчиков.' },
      { p: '1.3.3. Исполнитель имеет право в любой момент отозвать свое согласие на публичное размещение номера телефона и потребовать удаления профиля и данных (право на забвение), направив запрос в службу поддержки.' },
      { p: '1.3.4. Сервис осуществляет отправку исключительно сервисных (транзакционных) SMS-уведомлений (новые заказы, состояние баланса, модерация профиля, изменение тарифов). Рекламные (маркетинговые) рассылки не осуществляются.' },

      { h: '1.4. Применимое право и разрешение споров' },
      { p: '1.4.1. Настоящий Договор регулируется и толкуется в соответствии с законодательством Грузии.' },
      { p: '1.4.2. Все споры, возникающие в связи с использованием Сервиса, подлежат разрешению путем переговоров. При недостижении согласия спор передается на рассмотрение в суды Грузии по месту нахождения Сервиса.' },

      { h: '1.5. Приоритет языковых версий' },
      { p: '1.5.1. Настоящий Договор составлен на грузинском, русском и английском языках.' },
      { p: '1.5.2. В случае любых разночтений или несоответствий между языковыми версиями, безусловный юридический приоритет имеет версия на грузинском языке.' },

      { h: '1.6. Реквизиты Сервиса' },
      { requisites: true },
    ],
    en: [
      { h: '1.1. General Provisions' },
      { p: '1.1.1. This document constitutes a Public Offer (hereinafter referred to as the "Agreement") of the platform xtender.ge (hereinafter — "Service") and governs the terms of use for Contractors (movers, drivers, technicians) and Clients.' },
      { p: '1.1.2. Registration, authorization via entering a one-time SMS password (OTP), submitting an order, or creating a listing constitutes full and unconditional acceptance of this Agreement.' },
      { p: '1.1.3. The parties acknowledge that entering an SMS OTP code serves as an equivalent of a simple electronic signature. All actions taken after entering the OTP code are deemed to have been performed directly by the User. The User bears sole responsibility for the security of their SIM card and device.' },

      { h: '1.2. Service Status, Tax Compliance, and Limitation of Liability' },
      { p: '1.2.1. xtender.ge acts solely as an information technology platform (information intermediary). The Service is not an employer, contractor, agent, freight forwarder, or tax agent.' },
      { p: '1.2.2. Tax Compliance: The Contractor bears sole responsibility for compliance with the tax laws of Georgia, including self-declaring income, registering as an individual entrepreneur (if required), and paying all applicable taxes.' },
      { p: '1.2.3. All financial, contractual, and legal relations (including pricing, timelines, quality of service, and claims under Consumer Rights legislation) are established directly between the Client and the Contractor.' },
      { p: '1.2.4. AS IS Basis and Disclaimer of Liability: The Service is provided on an "AS IS" and "AS AVAILABLE" basis. The Service is NOT liable for:' },
      { ul: [
        "Any property damage caused by the Contractor to the Client's goods/items during moving or transportation;",
        'Poor, incomplete, or delayed performance of services by the Contractor, or non-payment by the Client;',
        'Technical outages, server disruptions, software bugs, or the accuracy of user-generated content.',
      ] },
      { p: '1.2.5. The Service reserves the right, without prior notice, to block or delete user profiles in the event of law violations, complaints, or false information listings.' },

      { h: '1.3. Personal Data & Right to Erasure' },
      { p: '1.3.1. Personal data processing is governed by a standalone Privacy Policy.' },
      { p: '1.3.2. By registering as a Contractor, the user explicitly consents to the public display of their name, phone number, and service description on xtender.ge for client communication purposes.' },
      { p: '1.3.3. The Contractor has the right at any time to withdraw consent for the public display of their phone number and request profile and data deletion (right to erasure/be forgotten) by contacting support.' },
      { p: '1.3.4. The Service sends exclusively service/transactional SMS notifications (order updates, balance alerts, profile moderation, tariff changes). No promotional or marketing SMS messages are distributed.' },

      { h: '1.4. Governing Law and Dispute Resolution' },
      { p: '1.4.1. This Agreement shall be governed by and construed in accordance with the laws of Georgia.' },
      { p: '1.4.2. Any disputes arising in connection with the use of the Service shall be settled through negotiations. If an agreement cannot be reached, the dispute shall be submitted to the jurisdiction of the courts of Georgia at the location of the Service.' },

      { h: '1.5. Language Precedence' },
      { p: '1.5.1. This Agreement is drafted in Georgian, Russian, and English.' },
      { p: '1.5.2. In the event of any discrepancies or conflicting interpretations between language versions, the Georgian version shall strictly prevail.' },

      { h: '1.6. Service Details & Legal Entity' },
      { requisites: true },
    ],
  },
};

// ──────────────────── ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ / PRIVACY ────────────────────

const privacy = {
  version: PRIVACY_VERSION,
  updated: { ka: '2026 წლის 3 სექტემბერი', ru: '3 сентября 2026 г.', en: 'September 3, 2026' },
  body: {
    ka: [
      { h: '2.1. ზოგადი დებულებები' },
      { p: '2.1.1. წინამდებარე კონფიდენციალურობის პოლიტიკა (შემდგომში — „პოლიტიკა") ადგენს პლატფორმა xtender.ge-ს (შემდგომში — „სერვისი") მიერ მომხმარებელთა (შემსრულებლები და დამკვეთები) პერსონალური მონაცემების შეგროვების, დამუშავების, შენახვისა და დაცვის წესებს.' },
      { p: '2.1.2. მონაცემთა დამუშავებისას სერვისი მოქმედებს საქართველოს კანონის „პერსონალურ მონაცემთა დაცვის შესახებ" შესაბამისად.' },
      { p: '2.1.3. სერვისით სარგებლობა და შესაბამისი ველის მონიშვნა (check-box) რეგისტრაციისას ნიშნავს მომხმარებლის სრულ თანხმობას ამ პოლიტიკის პირობებზე.' },

      { h: '2.2. რა მონაცემებს ვაგროვებთ' },
      { ul: [
        'ტელეფონის ნომერი: გამოიყენება ავტორიზაციისთვის (OTP-SMS-ის მეშვეობით) და სერვისული შეტყობინებების მისაღებად;',
        'პროფილის მონაცემები (შემსრულებლებისთვის): სახელი, ფოტო, მომსახურების კატეგორია, სამუშაოს აღწერილობა, ფასები, სამუშაო გეოგრაფია;',
        'ტექნიკური და აუდიტის მონაცემები: IP-მისამართი, მოწყობილობისა და ბრაუზერის ტიპი, რეგისტრაციისა და ოფერტაზე/პოლიტიკაზე თანხმობის მიცემის თარიღი და დრო (JSON-აუდიტ ლოგები), OTP-კოდების გაგზავნის ისტორია.',
      ] },

      { h: '2.3. მონაცემთა დამუშავების მიზნები და საჯაროობა' },
      { p: '2.3.1. მონაცემთა დამუშავების მიზნებია: სერვისზე წვდომის უზრუნველყოფა და SMS-OTP ავტორიზაცია; შემსრულებლებსა და დამკვეთებს შორის კომუნიკაციის დამყარება; ტრანზაქციული/სერვისული SMS-შეტყობინებების გაგზავნა; თაღლითობის პრევენცია და პლატფორმის უსაფრთხოების უზრუნველყოფა.' },
      { p: '2.3.2. მონაცემთა საჯაროობა (შემსრულებლებისთვის): შემსრულებელი ადასტურებს და იძლევა თანხმობას, რომ მისი სახელი, ტელეფონის ნომერი და მომსახურების აღწერილობა საჯაროდ გამოქვეყნდება ვებ-საიტზე xtender.ge, რათა დამკვეთებმა შეძლონ მასთან პირდაპირი დაკავშირება.' },
      { p: '2.3.3. სერვისი არ ახორციელებს მარკეტინგულ/სარეკლამო SMS-დაგზავნებს და არ ყიდის მონაცემებს მესამე პირებზე.' },

      { h: '2.4. მონაცემთა შენახვის ვადები და უსაფრთხოება' },
      { p: '2.4.1. პერსონალური მონაცემები ინახება იმ ვადით, რაც აუცილებელია დამუშავების მიზნების მისაღწევად ან კანონმდებლობით დადგენილი ვადით.' },
      { p: '2.4.2. მომხმარებელთა თანხმობის აუდიტ-ლოგები (JSON) ინახება უსაფრთხო სერვერებზე დაცულ ფორმატში.' },
      { p: '2.4.3. სერვისი იყენებს თანამედროვე ტექნიკურ და ორგანიზაციულ ზომებს (HTTPS შიფრაცია, წვდომის შეზღუდვა) მონაცემთა უკანონო წვდომისგან, შეცვლისგან ან განადგურებისგან დასაცავად.' },

      { h: '2.5. მომხმარებლის უფლებები (უფლება დავიწყებაზე)' },
      { p: 'საქართველოს კანონმდებლობის შესაბამისად, მომხმარებელს უფლება აქვს მიიღოს ინფორმაცია მისი მონაცემთა დამუშავების შესახებ, მოითხოვოს არაზუსტი მონაცემების გასწორება ან განახლება, და გამოითხოვოს თანხმობა და მოითხოვოს მონაცემთა წაშლა (უფლება დავიწყებაზე): მომხმარებელს შეუძლია ნებისმიერ დროს მოითხოვოს პროფილის გაუქმება და ტელეფონის ნომრის ამოღება საჯარო წვდომიდან, ელექტრონულ ფოსტაზე მოთხოვნის გაგზავნით: support@xtender.ge.' },

      { h: '2.6. მონაცემთა გადაცემა მესამე პირებისთვის' },
      { p: 'მონაცემები შეიძლება გადაეცეს მესამე პირებს მხოლოდ: ტელეკომუნიკაციების/SMS-ოპერატორებს (მხოლოდ OTP და სერვისული SMS-ების გაგზავნის მიზნით); საქართველოს სახელმწიფო/სამართალდამცავ ორგანოებს — კანონმდებლობით პირდაპირ გათვალისწინებულ შემთხვევებში.' },

      { h: '2.7. მონაცემთა დამუშავებაზე პასუხისმგებელი პირი (Data Controller)' },
      { requisites: true },
    ],
    ru: [
      { h: '2.1. Общие положения' },
      { p: '2.1.1. Настоящая Политика конфиденциальности (далее — «Политика») определяет порядок сбора, обработки, хранения и защиты персональных данных пользователей (Исполнителей и Заказчиков) платформы xtender.ge (далее — «Сервис»).' },
      { p: '2.1.2. При обработке данных Сервис руководствуется Законом Грузии «О защите персональных данных».' },
      { p: '2.1.3. Использование Сервиса и проставление отметки (чекбокса) при регистрации означает полное согласие Пользователя с условиями настоящей Политики.' },

      { h: '2.2. Какие данные мы собираем' },
      { ul: [
        'Номер телефона: используется для авторизации (через SMS-OTP) и получения сервисных уведомлений;',
        'Данные профиля (для Исполнителей): имя, фотография, категория услуг, описание работ, расценки, география оказания услуг;',
        'Технические и аудиторские данные: IP-адрес, тип устройства и браузера, дата и время регистрации и принятия согласий (JSON-логи аудита), история отправки OTP-кодов.',
      ] },

      { h: '2.3. Цели обработки и публичность данных' },
      { p: '2.3.1. Целями обработки данных являются: предоставление доступа к Сервису и авторизация по SMS-OTP; обеспечение связи между Исполнителями и Заказчиками; отправка транзакционных/сервисных SMS-уведомлений; предотвращение мошенничества и обеспечение безопасности платформы.' },
      { p: '2.3.2. Публичность данных Исполнителей: Исполнитель подтверждает и дает явное согласие на то, что его имя, номер телефона и описание услуг будут публично размещены на сайте xtender.ge для того, чтобы Заказчики могли связываться с ним напрямую.' },
      { p: '2.3.3. Сервис не осуществляет маркетинговые/рекламные рассылки и не передает данные третьим лицам в коммерческих целях.' },

      { h: '2.4. Сроки хранения и безопасность' },
      { p: '2.4.1. Персональные данные хранятся в течение срока, необходимого для достижения целей обработки, либо в течение сроков, установленных законодательством Грузии.' },
      { p: '2.4.2. Логи подтверждения согласий (JSON) хранятся на защищенных серверах в зашифрованном виде.' },
      { p: '2.4.3. Сервис применяет современные технические и организационные меры (HTTPS-шифрование, ограничение доступа) для защиты данных от несанкционированного доступа или удаления.' },

      { h: '2.5. Права пользователя (Право на забвение)' },
      { p: 'В соответствии с законодательством Грузии Пользователь имеет право получать информацию об обработке своих данных, требовать исправления неточных данных, и отозвать согласие и потребовать удаления данных (право на забвение): Пользователь может в любой момент отозвать согласие на публикацию номера телефона и потребовать полного удаления своего профиля, направив запрос на электронную почту: support@xtender.ge.' },

      { h: '2.6. Передача данных третьим лицам' },
      { p: 'Передача данных третьим лицам возможна только: телекоммуникационным операторам (исключительно для доставки OTP и сервисных SMS); государственным и правоохранительным органам Грузии — в случаях, прямо предусмотренных законом.' },

      { h: '2.7. Оператор персональных данных (Data Controller)' },
      { requisites: true },
    ],
    en: [
      { h: '2.1. General Provisions' },
      { p: '2.1.1. This Privacy Policy (hereinafter — "Policy") establishes the rules for collecting, processing, storing, and protecting personal data of users (Contractors and Clients) on the platform xtender.ge (hereinafter — "Service").' },
      { p: '2.1.2. The Service processes personal data in strict compliance with the Law of Georgia "On Personal Data Protection".' },
      { p: '2.1.3. Using the Service and ticking the consent box during registration constitutes the User\'s full acceptance of this Policy.' },

      { h: '2.2. Data We Collect' },
      { ul: [
        'Phone Number: used for authorization (via SMS-OTP) and service-related alerts;',
        'Profile Data (for Contractors): name, profile photo, service categories, description of work, rates, work geography;',
        'Technical and Audit Data: IP address, device/browser type, timestamp of registration and consent acceptance (JSON audit logs), OTP dispatch logs.',
      ] },

      { h: '2.3. Purposes of Processing and Public Display' },
      { p: '2.3.1. Purposes of processing include: providing access to the Service and authenticating via SMS-OTP; facilitating direct communication between Clients and Contractors; sending transactional/service SMS notifications; preventing fraud and maintaining platform safety.' },
      { p: '2.3.2. Public Display of Contractor Data: Contractors explicitly acknowledge and consent that their name, phone number, and service description will be publicly displayed on xtender.ge to enable Clients to contact them.' },
      { p: '2.3.3. The Service does NOT conduct marketing/promotional SMS campaigns nor sell personal data to third parties.' },

      { h: '2.4. Data Retention and Security' },
      { p: '2.4.1. Personal data is retained for as long as necessary to fulfill the processing purposes or as required by applicable Georgian laws.' },
      { p: '2.4.2. Consent audit logs (JSON) are stored securely on encrypted servers.' },
      { p: '2.4.3. The Service implements robust technical measures (HTTPS encryption, access controls) to prevent unauthorized access, alteration, or deletion of data.' },

      { h: '2.5. User Rights (Right to Erasure)' },
      { p: 'Pursuant to Georgian law, Users have the right to access information regarding their data processing, request correction of inaccurate data, and withdraw consent and request data erasure (Right to be Forgotten): Users may at any time withdraw consent for public phone number display and request full profile deletion by emailing: support@xtender.ge.' },

      { h: '2.6. Data Sharing with Third Parties' },
      { p: 'Data may only be shared with: telecommunication/SMS providers (solely for transmitting OTP and system SMS messages); state and law enforcement authorities of Georgia when strictly required by law.' },

      { h: '2.7. Data Controller Details' },
      { requisites: true },
    ],
  },
};

module.exports = { terms, privacy, REQUISITE_LABELS, REQUISITE_PENDING, LABELS };
