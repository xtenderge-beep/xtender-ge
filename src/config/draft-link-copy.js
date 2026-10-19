// Тексты страницы по ссылке-черновику от ИИ-ассистента (config/draftLink.js). «Задача» — как на главной
// («Опубликовать задачу»). Без обещаний цены, скорости и числа откликов; число исполнителей — живое, из
// каталога. Грузинский текст владелец вычитывает сам (docs/tasks.md).
module.exports = {
  ru: {
    draft_note_title: 'Текст задачи подготовил ИИ-ассистент',
    draft_note_body: 'Проверьте его и поправьте, если нужно. Пока вы не подтвердите номер кодом из SMS, задачу никто не увидит.',
    draft_note_services: 'Исполнители {city}:',
    draft_place: 'Место',
    draft_card_title: 'Задача: {title}',
    draft_card_fallback: 'Задача на xtender.ge',
  },
  en: {
    draft_note_title: 'Your AI assistant prepared this task',
    draft_note_body: 'Check it and edit it if needed. No one sees the task until you confirm your phone number with an SMS code.',
    draft_note_services: 'Providers {city}:',
    draft_place: 'Location',
    draft_card_title: 'Task: {title}',
    draft_card_fallback: 'A task on xtender.ge',
  },
  ka: {
    draft_note_title: 'დავალების ტექსტი AI-ასისტენტმა მოამზადა',
    draft_note_body: 'შეამოწმეთ და საჭიროების შემთხვევაში შეასწორეთ. სანამ ნომერს SMS-კოდით არ დაადასტურებთ, დავალებას ვერავინ ნახავს.',
    draft_note_services: 'შემსრულებლები {city}:',
    draft_place: 'ადგილი',
    draft_card_title: 'დავალება: {title}',
    draft_card_fallback: 'დავალება xtender.ge-ზე',
  },
};
