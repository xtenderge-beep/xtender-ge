// Заявку, для которой нужен инструмент, исполнитель без своего инструмента обычно пропускает.
// Подсказка на странице заявки говорит ему, что заявку можно взять: инструмент берут в прокат на день.
// Отметку «Нужен инструмент» менеджер ставит под услугой. Она лежит в потребностях заявки
// (orders.requirements.tools_needed — список услуг) и на подбор исполнителей не влияет.
const FLAG = 'tools_needed';

// Услуги, где исполнитель сам приезжает на технике: под ними отметки нет.
const VEHICLE_SERVICES = ['transport', 'flatbed', 'tow', 'bucket_lift', 'junk'];
const eligible = category => !VEHICLE_SERVICES.includes(category);

// Услуги заявки с отметкой.
function marked(order) {
  const list = order?.requirements?.[FLAG];
  return Array.isArray(list) ? list : [];
}

// matched — услуги заявки, по которым исполнитель ей сейчас подходит (serviceMatching.openMatches):
// подсказку видит тот, кто получил заявку по услуге с отметкой. Есть ли у него свой инструмент,
// мы не знаем, поэтому её видят все такие исполнители.
const needed = (order, matched) => marked(order).some(category => matched.includes(category));

// Tools4Rent — сторонняя фирма проката, с Xtender не связана. Работает в Тбилиси и Батуми
// (Яндекс Карты, 2026-10-07); язык на её сайте выбирает сам посетитель. Метка в адресе нужна,
// чтобы фирма видела у себя переходы от нас.
const available = citySlug => ['tbilisi', 'batumi'].includes(citySlug);
const catalogUrl = 'https://tools4rent.ge/catalog/?utm_source=xtender.ge&utm_medium=referral';

module.exports = { FLAG, eligible, marked, needed, available, catalogUrl };
