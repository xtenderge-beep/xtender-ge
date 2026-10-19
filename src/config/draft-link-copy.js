// Тексты страницы по ссылке-черновику от ИИ-ассистента (config/draftLink.js). С 2026-10-19 по просьбе владельца
// человек видит готовую заявку с кнопкой «Подтвердить заявку», поэтому здесь «заявка», а не «задача» главной.
// Без обещаний цены, скорости и числа откликов; число исполнителей — живое, из каталога. Грузинский текст
// владелец вычитывает сам (docs/tasks.md).
module.exports = {
  ru: {
    draft_note_title: 'Заявку подготовил ИИ-ассистент',
    draft_note_body: 'Проверьте её. Пока вы не подтвердите номер кодом из SMS, заявку никто не увидит.',
    draft_note_services: 'Исполнители {city}:',
    draft_place: 'Место',
    draft_confirm: 'Подтвердить заявку',
    draft_edit: 'Изменить',
    draft_edit_chat: 'Или попросите ассистента в чате исправить заявку и дать новую ссылку.',
    draft_card_title: 'Заявка: {title}',
    draft_card_fallback: 'Заявка на xtender.ge',
    // Подпись ссылки на /llms.txt внизу главной; за ней адрес текстом.
    footer_ai_link: 'Для ИИ-ассистентов:',
  },
  en: {
    draft_note_title: 'Your AI assistant prepared this request',
    draft_note_body: 'Check it. No one sees the request until you confirm your phone number with an SMS code.',
    draft_note_services: 'Providers {city}:',
    draft_place: 'Location',
    draft_confirm: 'Confirm request',
    draft_edit: 'Edit',
    draft_edit_chat: 'Or ask the assistant in your chat to fix the request and give you a new link.',
    draft_card_title: 'Request: {title}',
    draft_card_fallback: 'A request on xtender.ge',
    footer_ai_link: 'For AI assistants:',
  },
  ka: {
    draft_note_title: 'განაცხადი AI-ასისტენტმა მოამზადა',
    draft_note_body: 'შეამოწმეთ. სანამ ნომერს SMS-კოდით არ დაადასტურებთ, განაცხადს ვერავინ ნახავს.',
    draft_note_services: 'შემსრულებლები {city}:',
    draft_place: 'ადგილი',
    draft_confirm: 'განაცხადის დადასტურება',
    draft_edit: 'შეცვლა',
    draft_edit_chat: 'ან სთხოვეთ ასისტენტს ჩატში, შეასწოროს განაცხადი და მოგცეთ ახალი ბმული.',
    draft_card_title: 'განაცხადი: {title}',
    draft_card_fallback: 'განაცხადი xtender.ge-ზე',
    footer_ai_link: 'AI-ასისტენტებისთვის:',
  },
};
