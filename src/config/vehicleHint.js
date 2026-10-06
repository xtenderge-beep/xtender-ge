// Машин в каталоге мало, а заказчик переезда хочет «под ключ». Грузчик без своей машины такую
// заявку обычно пропускает. Подсказка на странице заявки говорит ему, что заявку можно взять:
// грузовую машину он вызовет в Yandex Go сам или объяснит заказчику, как её вызвать.
const VEHICLE = ['transport', 'flatbed'];
const any = (list, keys) => list.some(key => keys.includes(key));

// Отметка менеджера «Клиенту нужна и машина» у услуги «Грузчики». Лежит в потребностях заявки
// (orders.requirements), на подбор исполнителей не влияет.
const FLAG = 'movers_need_vehicle';
const flagged = order => order?.requirements?.[FLAG] === true;

// open — незакрытые услуги заявки, matched — те из них, по которым исполнитель ей подходит
// (serviceMatching.openMatches). Машина заявке нужна, если менеджер поставил отметку или в заявке
// открыта перевозка: заказчик нашёл машину и закрыл перевозку — подсказка по ней уходит.
// Подсказку не видит тот, чья машина подходит открытой перевозке, а при одной отметке — любой
// исполнитель со своей машиной (ownsVehicle): подходит ли она, без перевозки в заявке неизвестно.
function needed(open, matched, wanted = false, ownsVehicle = false) {
  if (!matched.includes('movers') || any(matched, VEHICLE)) return false;
  return any(open, VEHICLE) || (wanted && !ownsVehicle);
}

// Грузовой тариф Яндекса в Грузии работает только в Тбилиси (delivery.yandex.com/ge-en/cargo,
// проверено 2026-10-07): в заявке из другого города подсказки нет.
const available = citySlug => citySlug === 'tbilisi';

// Страница Яндекса о грузовом тарифе в Тбилиси со снимком экрана приложения и формой заказа.
// Есть на грузинском и английском, русской нет.
const guideUrl = lang => 'https://delivery.yandex.com/' + (lang === 'ka' ? 'ge-ka' : 'ge-en') + '/cargo/tbilisi/';

module.exports = { FLAG, flagged, needed, available, guideUrl };
