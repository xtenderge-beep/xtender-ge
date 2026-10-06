// Подсказка грузчику на заявке, где нужна и машина (config/vehicleHint.js). Тариф назван так, как
// его называет сам Яндекс: «სატვირთო» и Cargo на его страницах для Грузии, «Грузовой» — в русском
// интерфейсе приложения. Что Яндекс не возит — из его правил для водителей грузового тарифа в
// Тбилиси (pro.yandex.com, Cargo deliveries). Цен и размеров машин здесь нет: их показывает приложение.
module.exports = {
  ru: {
    vehicle_hint_title: 'Заказчику нужна и машина',
    vehicle_hint_lead: 'Своей машины нет? Заявку всё равно можно взять: вызовите грузовую в Yandex Go сами или подскажите заказчику, как её вызвать.',
    vehicle_hint_how: 'Как вызвать машину',
    vehicle_hint_step1: 'Узнайте у заказчика, что везём, откуда и куда, какой этаж и есть ли лифт.',
    vehicle_hint_step2: 'В приложении Yandex Go выберите тариф «Грузовой» (Cargo), укажите оба адреса и размер машины. Приложение покажет цену.',
    vehicle_hint_step3: 'Назовите заказчику цену машины и цену своей работы. Договоритесь, кто платит за машину.',
    vehicle_hint_step4: 'Закажите машину ко времени погрузки. Спросите водителя, сколько человек поедет в кабине.',
    vehicle_hint_limits: 'Пианино, сейфы и строительный мусор Yandex Go не возит.',
    vehicle_hint_link: 'Как это выглядит в Yandex Go',
  },
  en: {
    vehicle_hint_title: 'The customer also needs a vehicle',
    vehicle_hint_lead: 'No vehicle of your own? You can still take this request: order a cargo vehicle in Yandex Go yourself, or tell the customer how to order one.',
    vehicle_hint_how: 'How to order a vehicle',
    vehicle_hint_step1: 'Ask the customer what is being moved, from where and to where, which floor, and whether there is an elevator.',
    vehicle_hint_step2: 'In the Yandex Go app choose the Cargo rate, enter both addresses and the truck size. The app shows the price.',
    vehicle_hint_step3: 'Tell the customer the price of the vehicle and the price of your work. Agree on who pays for the vehicle.',
    vehicle_hint_step4: 'Order the vehicle for the loading time. Ask the driver how many people can ride in the cab.',
    vehicle_hint_limits: 'Yandex Go does not carry pianos, safes or construction waste.',
    vehicle_hint_link: 'See how it looks in Yandex Go',
  },
  ka: {
    vehicle_hint_title: 'დამკვეთს მანქანაც სჭირდება',
    vehicle_hint_lead: 'საკუთარი მანქანა არ გაქვთ? განაცხადის აღება მაინც შეგიძლიათ: სატვირთო მანქანა თავად გამოიძახეთ Yandex Go-ში ან დამკვეთს აუხსენით, როგორ გამოიძახოს.',
    vehicle_hint_how: 'როგორ გამოვიძახოთ მანქანა',
    vehicle_hint_step1: 'ჰკითხეთ დამკვეთს, რა უნდა გადაიტანოთ, საიდან და სად, რომელი სართულია და არის თუ არა ლიფტი.',
    vehicle_hint_step2: 'Yandex Go-ს აპლიკაციაში აირჩიეთ ტარიფი „სატვირთო“, მიუთითეთ ორივე მისამართი და საბარგულის ტიპი. აპლიკაცია ფასს გაჩვენებთ.',
    vehicle_hint_step3: 'უთხარით დამკვეთს მანქანის ფასი და თქვენი სამუშაოს ფასი. შეთანხმდით, ვინ გადაიხდის მანქანის საფასურს.',
    vehicle_hint_step4: 'გამოიძახეთ მანქანა დატვირთვის დროისთვის. ჰკითხეთ მძღოლს, რამდენი ადამიანი ჩაეტევა კაბინაში.',
    vehicle_hint_limits: 'პიანინოს, სეიფებს და სამშენებლო ნარჩენებს Yandex Go არ გადაზიდავს.',
    vehicle_hint_link: 'ნახეთ, როგორ გამოიყურება Yandex Go-ში',
  },
};
