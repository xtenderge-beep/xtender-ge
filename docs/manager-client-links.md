# Менеджерские ссылки для заказчиков

На старте органического трафика мало — менеджеры обзванивают потенциальных клиентов.
Менеджер даёт клиенту персональную ссылку, клиент по ней оставляет заявку, заявка
привязывается к менеджеру, в админке — воронка по каждому менеджеру.

Аналог реферальной системы для исполнителей (`/ref`, `promo_codes.manager_id`), но для
клиентской стороны.

---

## 1. Флоу

```
Клиент звонит менеджеру (менеджер знает его телефон)
      ↓
Менеджер:  /link +995XXXXXXXXX   в боте   (или форма в /admin/managers/:id)
      ↓  создаётся строка client_invites (token, manager_id, phone)
Менеджер отправляет клиенту  xtender.ge/z/<token>
      ↓
Клиент открывает → кука order_invite=<token>, opened_at, редирект на /#post-section
      ↓
Форма заявки: телефон уже подставлен (редактируемый). Клиент описывает задачу + фото → «Опубликовать» → SMS-код
      ↓
Заявка создаётся с orders.manager_id = менеджер;  client_invites.order_id = заявка
      ↓
Браузер → /o/<owner_token> (кабинет клиента: статус + «Снять заявку»); та же ссылка — отдельной SMS
после подтверждения кода
```

Галочек согласия на форме заявки нет и не нужно: публикация = акцепт оферты (п. 1.1.2).
Под кнопкой — строка «Нажимая, принимаю оферту».

SMS заказчику две (с 2026-10-11): сначала только код («Xtender code: 1234. Enter it on the site to
send your request.»), после подтверждения — ссылка на заявку («Xtender: request #N is sent. Status and
closing: …»). Раньше код и ссылка шли одной SMS: люди открывали ссылку, видели страницу заявки со
статусом «Активна» и код не вводили — заявка оставалась неподтверждённой. Так же устроено подтверждение
по ссылке менеджера `/d/<token>`. Страница неподтверждённой заявки теперь пишет «Не отправлена».

Шаг с кодом в форме на сайте (`src/views/index.ejs`, с 2026-10-12) — место, где заявки терялись, поэтому:
- На телефоне это отдельный экран во весь размер (`body.otp-active` в `src/styles/input.css`): номер,
  на который ушёл код, поле кода, «Подтвердить и отправить», «Отправить код ещё раз» (через 30 секунд),
  «Изменить номер». Раньше после запроса кода страница сжималась, и поле кода оказывалось на
  500–1000 px выше экрана.
- Четыре цифры отправляются сами; кнопка остаётся запасным путём.
- Повторный код идёт по той же заявке: форма присылает `token`, `order.service.reusePendingOrder`
  берёт прежний черновик, если совпал телефон. Кодов на номер по-прежнему три в час.
- Шаг переживает перезагрузку вкладки: `sessionStorage`, ключ `xt_code_step`, десять минут. Фото при
  перезагрузке не сохраняются.
- Браузер может сам подставить код из SMS (Android Chrome, `navigator.credentials.get({ otp })`), если
  в SMS есть последняя строка `@xtender.ge #1234`. Строку добавляет настройка «Код из SMS
  подставляется сам» в `/admin/settings` (`app_settings.order_code_sms_autofill`), **по умолчанию
  выключена**: владелец включает её и сразу проверяет настоящей SMS, что шлюз доставляет строку целой.
  Если шлюз такую SMS не принял, `otp.service` тут же отправляет обычную.

## 2. Где менеджер берёт ссылку

- **Бот:** `/link +995XXXXXXXXX` → ссылка в ответ. `/mystats` — воронка.
- **Админка:** `/admin/managers/:id` → форма «телефон → Сгенерировать ссылку».

Менеджер должен быть заведён в `/admin/managers` и привязать Telegram (как для `/ref`).

## 3. Воронка

`manager.service.getClientFunnel(managerId)` — в JS по двум плоским выборкам (pg-mem не
тянет коррелированные подзапросы):

| метрика | как считается |
|---|---|
| Ссылок | строк `client_invites` |
| Открыли | `opened_at IS NOT NULL` |
| Заявок | `order_id IS NOT NULL` |
| Разослано | у заявки `first_dispatched_at` |
| Связались | по заявке есть `order_views` с `call`/`whatsapp` |
| Закрыто | `orders.status = 'closed'` |

Показывается в `/admin/managers/:id` и в `/mystats` бота. `/admin/orders` — у каждой
заявки строка «менеджер: Имя».

## 4. Фото модератору в Telegram

Отдельно в этом же заходе: `notifyModerator` после текстового сообщения дошлёт фото
(`sendPhoto` для одного, `sendMediaGroup` для нескольких, `sendDocument` для не-картинок)
всем чатам модераторов, подпись «📎 Фото к заявке #N». URL публичный (`getBaseUrl() +
file_path`), Telegram тянет сам — как чеки на пополнение (`sendTopupReceipt`). Только при
первой рассылке, `updateMessage` фото не повторяет. В dev (Telegram выключен) не шлётся.

## 5. Файлы

| Что | Где |
|---|---|
| Схема | `schema.sql` — `client_invites`, `orders.manager_id` |
| Сервис | `manager.service.js` — `createClientInvite`, `getClientInvite`, `markInviteOpened`, `linkInviteToOrder`, `getClientFunnel` |
| Ссылка `/z/:token` + prefill на `/` | `routes/public.routes.js` |
| Привязка при создании заявки | `otp.controller.send` (читает куку `order_invite`) → `order.service.createPendingOrder({ managerId })` |
| Редирект в кабинет | `order.controller.create` возвращает `ownerLink`; `index.ejs` `verifyOtp()` делает `window.location` |
| Бот `/link`, `/mystats` | `order.controller.js` `handleManagerCommand` |
| Админ-форма + воронка | `admin.controller.managerClientLink` + `manager-detail.ejs`; `admin.routes.js` |
| Колонка в заявках | `admin.service.listOrdersAdmin` (JOIN managers) + `admin/orders.ejs` |
| Фото модератору | `telegram.service.notifyModerator` |

## 6. Проверено

E2E на dev-server: менеджер создан → сгенерирована ссылка через админ-форму → `/z/<token>`
ставит куку и редиректит → на `/` телефон подставлен → заявка создана с `manager_id`,
`ownerLink` возвращён, `client_invites.order_id` заполнен → воронка в `/admin/managers/:id`
показывает «Ссылок 1, Открыли 1, Заявок 1» → в `/admin/orders` строка «менеджер: …».
