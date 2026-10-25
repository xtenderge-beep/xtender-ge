# Xtender: как устроено внутри

Технический обзор всей системы: устройство, окружения, данные, логика каждой части, фоновые процессы, безопасность,
проверки, выкладка и технические долги. Для каждой части — где код и какой документ подробнее.

Обновлено **25.10.2026**. Зачем проект и куда идёт — [project-overview.md](project-overview.md). Карта документов —
[README.md](README.md). Если обзор расходится с кодом — верен код; исправьте обзор.

## Содержание

1. [Устройство](#1-устройство)
2. [Окружения и переменные](#2-окружения-и-переменные)
3. [Данные](#3-данные)
4. [Логика по частям](#4-логика-по-частям)
5. [Фоновые процессы](#5-фоновые-процессы)
6. [Безопасность и приватность](#6-безопасность-и-приватность)
7. [Проверки](#7-проверки)
8. [Выкладка и откат](#8-выкладка-и-откат)
9. [Технические долги и ограничения](#9-технические-долги-и-ограничения)

---

## 1. Устройство

**Стек.** Node.js, Express 4, шаблоны EJS, PostgreSQL (`pg`), Redis (`ioredis`), Tailwind (сборка в
`public/css/app.css`), набор иконок Font Awesome (`npm run build:fa`). Библиотеки: `@modelcontextprotocol/sdk` (MCP),
`zod`, `multer` (загрузки), `exceljs` (выписки), `pdfkit` (счета), `axios` (SMS-шлюз, Telegram, OpenRouter).
Хостинг — Railway; домен через Cloudflare.

**Один процесс, модульный монолит.** Папки:

| Папка | Что внутри |
|---|---|
| `src/app.js` | Точка входа: middleware, маршруты, миграции при старте, запуск фоновых процессов |
| `src/routes/` | `public.routes.js` (страницы, ka без приставки, `/ru`, `/en`), `api.routes.js` (`/api/*` сайта), `apiV1.routes.js` (`/api/v1`), `oauth.routes.js` (`/.well-known/*`, `/oauth/*`), `admin.routes.js` (`/admin`), `managerPortal.routes.js` (`/manager`), `crmPublic.routes.js` |
| `src/controllers/` | Обработчики запросов; `mcp.controller.js` и `mcpDeal.tools.js` — сервер MCP |
| `src/services/` | Бизнес-логика (около 70 сервисов): заявки, рассылка, деньги, согласия, сделка, каталог |
| `src/config/` | Справочники и тексты: категории и поля (`serviceTypes.js`, `junkBody.js`, `requestFields.js`, `units.js`, `categoryTexts.js`), тексты (`i18n.js`, `*-copy.js`), юридическое (`legal.js`, `legal-content.js`), API (`apiV1.js`, `openapiV1.js`, `deal.js`) |
| `src/views/` | EJS: публичные страницы, `admin/`, `manager/`, `partials/` (в том числе страницы сделки `deal-owner.ejs`, `deal-provider.ejs`) |
| `public/` | Статика: `css/`, `js/` (поиск, сделка, аналитика визитов), загрузки `uploads/` |
| `schema.sql`, `schema.postgres.sql` | Полная схема; выполняется при каждом старте |
| `scripts/` | Песочница API, проверка тестового окружения, сборка OpenAPI YAML, выгрузка журнала согласий, демо-исполнители |
| `tests/` | `node --test tests/*.test.js` |

**Старт приложения** (`src/app.js`): применить `schema.sql` и `schema.postgres.sql` (если не `SKIP_DB_MIGRATIONS`) →
однократные переносы данных (например, `category.service.migrateTexts`) → переустановить вебхук Telegram → запустить
фоновые процессы (раздел 5) → в песочнице с `SANDBOX_SEED=1` создать тестовых исполнителей.

**Основные адреса.**

| Адрес | Что |
|---|---|
| `/`, `/ru`, `/en`, `/s/<slug>` | Главная и страницы задач и «услуга + город» (один шаблон `index.ejs`) |
| `/join` | Регистрация исполнителя |
| `/order/<token>` | Страница заявки: исполнителю (по ссылке из SMS или после входа) и заказчику (с кукой владельца) |
| `/o/<owner_token>` | Ссылка заказчика на свою заявку (ставит куку владельца) |
| `/master/<token>` | Кабинет исполнителя (после входа по коду) |
| `/draft`, `/chatgpt`, `/llms.txt`, `/openapi.json`, `/v1/rfq/*`, `POST /mcp` | Мост к ИИ-ассистентам |
| `/api/v1/*`, `/.well-known/*`, `/oauth/*` | API v1 и вход OAuth (ветка `api-v1-stage1`) |
| `/consent/<token>`, `/t/<token>` | Согласие перед первой публикацией из ChatGPT; страница возврата из SMS сделки |
| `/z/<token>`, `/p/<id>-<token>`, `/go/<code>` | Ссылки менеджера для заказчика, реферальная ссылка исполнителя, ссылка площадки |
| `/admin/*`, `/manager/*` | Админка и кабинет менеджера |
| `/health` | Проверка, что процесс отвечает (базу не проверяет) |

## 2. Окружения и переменные

| Окружение | Где | Ветка | Особенности |
|---|---|---|---|
| Рабочее | Railway `fabulous-luck` / `production`, `https://xtender.ge` | `main` | Настоящие SMS, Telegram, деньги. Выкладка — отправкой в `main` |
| Тестовое | Railway `fabulous-luck` / `staging`, `https://cooperative-liberation-staging.up.railway.app` | `api-v1-stage1` | Своя база и Redis, песочница `XTENDER_SANDBOX=1`, тестовые исполнители |
| Локальное | `node dev-server.js` (порт 3000) | любая | pg-mem и Redis в памяти, SMS в консоль, 50 демо-исполнителей |
| Песочница API | `node scripts/api-sandbox.js` (порт 3100) | любая | pg-mem, песочница, заказчик и исполнители из `src/config/sandboxData.js` |

**Никогда не запускать `node src/app.js` локально с рабочим `.env`**: он подключится к рабочей базе и отправит
настоящие SMS.

**Песочница** (`XTENDER_SANDBOX=1`): SMS не уходят в шлюз, а складываются в Redis и видны на
`/api/v1/sandbox/sms?key=…` (в браузере — таблица со ссылками). Настоящая SMS — только на номера
`SANDBOX_REAL_SMS_NUMBERS`: код входа всегда, уведомления сделки заказчику — при `SANDBOX_REAL_DEAL_SMS=1`. Рассылки
исполнителям — всегда в приёмник. Telegram, Google Analytics, пиксель Meta выключены; ответы с `X-Robots-Tag: noindex`.

**Переменные** (полный список с пояснениями — `.env.example`):

| Группа | Переменные |
|---|---|
| Основное | `PORT`, `NODE_ENV`, `DOMAIN` (адрес без протокола), `PUBLIC_BASE_URL` (если не `https://$DOMAIN`), `DATABASE_URL`, `REDIS_URL`, `SKIP_DB_MIGRATIONS` |
| SMS | `SMS_GATEWAY_URL`, `SMS_GATEWAY_USERNAME`, `SMS_GATEWAY_PASSWORD` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MODERATOR_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` |
| Админка | `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `ADMIN_PHONE` (включает вход с SMS), `ADMIN_2FA_RECOVERY_CODE` |
| Модель OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_TRANSLATION_MODEL`, `OPENROUTER_BRIEF_MODEL`, `OPENROUTER_MATCH_MODEL`, `TASK_MATCH_DAILY_LIMIT` |
| Учёт | `GA_MEASUREMENT_ID`, `META_PIXEL_ID` |
| Согласия | `CONSENT_HASH_PEPPER` |
| API v1, OAuth | `OAUTH_REDIRECT_ALLOWLIST`, `OAUTH_ALLOW_LOOPBACK`, `DEAL_WORKER` |
| Песочница | `XTENDER_SANDBOX`, `SANDBOX_REAL_SMS_NUMBERS`, `SANDBOX_REAL_DEAL_SMS`, `SANDBOX_SEED`, `SANDBOX_SINK_KEY` |

## 3. Данные

PostgreSQL; схема — `schema.sql`, выполняется при **каждом** старте. Поэтому: только `CREATE … IF NOT EXISTS` и
`ALTER … ADD COLUMN IF NOT EXISTS`; новые таблицы — выше строки `-- Multiple provider services and immutable dispatch
context.`; перенос данных — с защитой от повторного применения (иначе он повторится при каждой выкладке, прецедент —
30.09.2026). Триггеры и функции, которые не тянет pg-mem, — в `schema.postgres.sql`. Деньги — целые тетри (1 ₾ = 100).

| Область | Таблицы |
|---|---|
| Заявки | `orders` (текст, город, район, статус, `token` и `owner_token`, `target_categories`, `requirements`, переводы, источник, поля сделки), `order_files`, `order_views` (клики исполнителей), `order_category_closures`, `order_moderation_messages` |
| Рассылка | `order_dispatches`, `dispatch_runs`, `dispatch_deliveries`, `lead_links` (личные ключи ссылок), `order_requirement_events` (журнал требований) |
| Исполнители | `masters` (профиль, баланс, `paid_mode`, `is_subscribed`, языки, `signup_kinds`), `master_services` (услуга + характеристики), `master_cities`, `master_districts`, `master_reviews`, `master_admin_events`, `admin_master_followups` |
| Каталог услуг | `service_categories` (код, названия, поля исполнителя с правилами подбора, параметры заявки, описания, слова поиска, версия, активность), `cities`, `districts` |
| Деньги | `balance_transactions`, `topup_requests`, `topup_receipts`, `bank_statement_credits`, `card_payments` (заготовка под BOG), `promo_codes`, `master_billing_acceptances`, `app_settings` |
| Каталог и контакты | `catalog_contact_access`, `catalog_contact_events`, `technical_client_phones` (тестовые номера — без списаний) |
| Согласия | `sms_consent_logs` (только добавление; на настоящем PostgreSQL закреплено триггером), `consent_uses` |
| Менеджеры и партнёры | `managers`, `manager_portal_events`, `manager_master_views`, `crm_invites`, `crm_notes`, `manager_plans`, `client_invites`, `manager_commissions`, `manager_payouts`, `partner_audit` |
| Учёт и страницы | `site_visits`, `traffic_sources`, `landing_pages`, `support_messages` |
| API v1 (ветка) | `accounts`, `oauth_clients`, `oauth_grants`, `oauth_authorization_codes`, `oauth_tokens`, `api_idempotency_keys` |
| Сделка (ветка) | `order_items`, `order_access`, `offers`, `offer_versions`, `order_threads`, `order_messages`, `order_selections`, `outbox_events`, `notification_deliveries`, `order_notifications`, `resume_links` |

**Статусы заявки** (`orders.status`): `unverified` (черновик до кода из SMS) → `pending_review` (у модератора) →
`new` (разослана) → `closed`. До первой рассылки возможен возврат: `pending_review` → `needs_revision` →
`pending_review`.

**Статусы сделки** (`orders.deal_status`, только у заявок с предложениями): `open` → `selection_pending` → `awarded` →
`completed`, либо `cancelled`. «Сбор закрыт» не хранится отдельно — это истёкший `submission_deadline`.

## 4. Логика по частям

### 4.1. Заявка сайта

Форма → `POST /api/otp/send` создаёт черновик `unverified` и шлёт код → `POST /api/otp/verify` → `POST /api/orders`
подтверждает: `pending_review`, файлы, уведомление модератору (`order.controller.announceConfirmed`: SMS заказчику со
ссылкой `/o/…`, перевод текста на ka/ru/en с ожиданием до 7 с, сообщение в Telegram, карточка «Кратко»). Только
грузинские номера. Возврат на исправление и правка — `orderRevision.service`, `orderText.service`. Заказчик закрывает
заявку или отдельные услуги; исполнителям, уже открывшим заявку, SMS о закрытии не приходит (осознанное решение), а
по старой ссылке они видят, что заявка закрыта.

Код: `src/controllers/otp.controller.js`, `order.controller.js`, `src/services/order.service.js`.
Подробнее: [multi-category-orders.md](multi-category-orders.md), [order-translation.md](order-translation.md),
[georgian-phone-numbers.md](georgian-phone-numbers.md), [technical-testing.md](technical-testing.md).

### 4.2. Модерация и рассылка

Модератор отмечает услуги и требования в Telegram, в админке (`/admin/orders/:token`) или на экране менеджера
(`/manager/orders/:token`). **Предварительный расчёт и отправка — одна функция** (`dispatch.service`:
`screen`, `planNeeds`, `sendNeeds` → `order.service.notifyMasters` → `getDispatchRecipients`).

- **Подбор.** Исполнитель подходит, если у него есть услуга, он в городе заявки, активен, не отписан, язык подходит,
  и каждая характеристика проходит правило поля: `exact` (совпадение), `gte` (возможность не меньше требования —
  объём, грузоподъёмность), `flag` (нужно подтверждённое «да»), `ignore` (не участвует). Неизвестная характеристика не
  подходит. У перевозчика несколько машин — подходит, если подходит хотя бы одна.
- **Требования** хранятся в `orders.requirements` по услугам — снимок на момент настройки: позднейшая правка категории
  не расширяет открытую рассылку молча. После первой отправки заявку можно только расширять.
- **Одно уведомление** исполнителю, подходящему нескольким услугам; один платёж. Форма передаёт то, что видел
  модератор (`expectedTotal`, `expectedPrice`, `revision`); если что-то изменилось — ничего не отправляется.
- **Учёт.** Каждая попытка и причина пропуска — `dispatch_runs`/`dispatch_deliveries`; отчёт «кто получил и сколько
  списано»; «Дослать новым».

Подробнее: [dynamic-service-dispatch.md](dynamic-service-dispatch.md), [multi-service-dispatch.md](multi-service-dispatch.md),
[dispatch-by-language.md](dispatch-by-language.md).

### 4.3. Исполнители и категории

Регистрация `/join` (`master.controller.js`): «Кто вы?», услуги, города и языки, профиль, согласия, код из SMS →
`masters.is_active = false` → модератор одобряет и назначает услуги и характеристики (`/manager/review/:id`,
`/admin/masters/:id`). Вход в кабинет — по коду из SMS (`masterSession.service`, Redis). Имя показывается латиницей
(транслитерация), описание переводится на три языка в фоне.

Категории — данные: `/admin/categories` создаёт услугу, поля исполнителя (тип, правило подбора, фильтр каталога),
параметры заявки с привязкой к полю исполнителя (`maps_to`: поле и правило, например «вес груза ≤ грузоподъёмность»),
описания и слова поиска на ka/ru/en и латиницей, единицы только из справочника `units.js`. Версия категории меняется
при правке. Встроенные поля — `serviceTypes.js`, `junkBody.js` (вывоз мусора, кузов, грузоподъёмность), `requestFields.js`.

Подробнее: [service-types.md](service-types.md) (движок типов услуг; часть про этап 5 устарела), раздел 5 в
[api-v1/WORKFLOWS.md](api-v1/WORKFLOWS.md).

### 4.4. Деньги

`providerBilling.service` решает, платный ли исполнитель (`paid_mode`), хватает ли баланса и есть ли основание
списать (подтверждённые тарифы или только подарочный баланс). Бесплатный исполнитель получает заявку при любом
балансе; в `balance_transactions` пишется `lead_charge` с суммой 0 — по ней система знает, кому заявка ушла
(повторы, доступ к контакту, отчёты). Показ номера в каталоге — `catalog_call`, один раз на пару «исполнитель +
номер звонящего». Пополнение: счёт (PDF), перевод, сверка банковской выписки (`bankStatement.service`), подтверждение
администратором. Подтверждение тарифов привязано к хешу текстов `billing_*` — эти строки не править без нужды.

Подробнее: [pricing-and-monetization.md](pricing-and-monetization.md), [provider-consent-and-billing.md](provider-consent-and-billing.md),
[contact-access-and-charge-evidence.md](contact-access-and-charge-evidence.md), [catalog-contact-access.md](catalog-contact-access.md).

### 4.5. Согласия и юридическое

Каждое подтверждение кода — строка в `sms_consent_logs` с IP, браузером, версией оферты и политики и текстом
согласия; каждая SMS — строка доставки. Код хранится только хешем (с `CONSENT_HASH_PEPPER`). Тексты оферты и
политики — `legal-content.js`, версии и реквизиты — `legal.js`. Выгрузка — `/admin/consent`,
`scripts/export-consent-log.js`.

Подробнее: [consent-and-legal.md](consent-and-legal.md).

### 4.6. Сообщения

- **SMS** (`sms.service.js`): GET на шлюз, только латиница (шлюз портит остальное), ответ `0000-…` — принято.
  Справочник текстов — `service-message-copy.js`. Неясный ответ шлюза — отказ (для сделки — `unknown` без повтора).
- **Telegram** (`telegram.service.js`): чат модераторов (новые заявки и исполнители, кнопки рассылки, обновление
  сообщения с воронкой), бот исполнителя (заявки вместо SMS), команды пополнения. Вебхук защищён секретом.
- **Модель OpenRouter** (по умолчанию `google/gemini-2.5-flash-lite`): перевод заявок (`translation.service`), карточка
  «Кратко» (`orderBrief.service`), перевод описаний исполнителей, подбор по смыслу (`taskMatch.service`, на странице
  только с `?ai=1`). Без ключа всё работает без этих функций.

### 4.7. Каталог, поиск, страницы

Главная, страницы задач и «услуга + город» — один шаблон `index.ejs` (`simpleHome`). Поле задачи — оно же поиск:
словарь `service-search-words.js` (слова групп, хэштеги-особенности, слова поиска из админки) и `public/js/service-search.js`.
Страница «услуга + город» открыта поиску с трёх исполнителей, ниже — `noindex`, без исполнителей — 404
(`servicePages.service.js`). `canonical`, `hreflang`, карта сайта, разметка.

Подробнее: [seo.md](seo.md), [landing-pages.md](landing-pages.md).

### 4.8. Учёт и аналитика

Визиты и источники — `site_visits` (`siteAnalytics.service`, `public/js/visit.js`), площадки — `traffic_sources`
(`/go/<code>`); браузер сотрудника помечен (`xt_staff`) и не считается. Админка: обзор, воронки, люди, цифры на
вкладках меню (`dashboard.service`, `adminNav.service`). Google Analytics и пиксель Meta — `googleTag.js`, `metaPixel.js`.

Подробнее: [admin-analytics.md](admin-analytics.md), [traffic-sources.md](traffic-sources.md),
[google-analytics.md](google-analytics.md), [meta-pixel.md](meta-pixel.md).

### 4.9. Менеджеры и партнёры

Кабинет `/manager`: исполнители менеджера, проверка профилей, заявки (для главного модератора), ссылки для заказчиков
`/z/…`, реферальные ссылки исполнителей `/p/…`, заметки и планы. Комиссии и выплаты — `partner.service`.

Подробнее: [manager-portal.md](manager-portal.md), [manager-partners.md](manager-partners.md),
[manager-client-links.md](manager-client-links.md), [crm-processes.md](crm-processes.md).

### 4.10. Мост к ИИ-ассистентам (рабочий сайт)

`/llms.txt` и блок «Для ИИ-ассистентов» учат ассистента собирать ссылку `/draft?lang=&cats=&loc=&title=&items=&note=`
— она открывает заполненную заявку, дальше обычная форма с кодом. `POST /v1/rfq/create|verify` — то же через API с
кодом из SMS. Анонимный `POST /mcp`: `list_services`, `create_request_link`. Каталог для них — `assistantCatalog.service`,
тексты — `agentApi.js`. Кнопка «Решить с ChatGPT» открывает chatgpt.com с готовым запросом (`partials/ai-solve.ejs`).

Подробнее: [ai-agent-api.md](ai-agent-api.md).

### 4.11. API v1 и вход OAuth (ветка `api-v1-stage1`)

Аккаунт — номер, подтверждённый кодом на `/oauth/authorize` (OAuth 2.1, PKCE S256, регистрация клиента RFC 7591,
`iss` в ответе, адреса возврата — ChatGPT и Claude). Токены и коды хранятся хешами; access-токен — час, refresh — 30 дней
с ротацией. Роль исполнителя — профиль `masters` с тем же номером. Общий формат ошибок с `request_id`, версии через
`If-Match`, `Idempotency-Key` у внешних действий, 120 запросов в минуту на сессию. Контракт — `src/config/openapiV1.js`
→ `docs/api-v1/openapi.yaml` (`node scripts/build-openapi-yaml.js`).

Подробнее: [api-v1/README.md](api-v1/README.md), [api-v1/AUTH.md](api-v1/AUTH.md).

### 4.12. Сделка (ветка `api-v1-stage1`)

Заявка из ChatGPT — та же строка `orders` с `channel`, `response_mode`, позициями `order_items` и полями сделки.

- **Черновик и проверка** (`tender.service`): вся заявка по текущей схеме категорий — типы, варианты, диапазоны,
  единицы, обязательные поля; `fixes` с перечнем исправлений; оценка числа подходящих исполнителей той же функцией,
  что у рассылки. Изменилась схема после сохранения черновика — `409 CATEGORY_SCHEMA_CHANGED`.
- **Согласие** перед первой публикацией (`accountConsent.service`, `/consent/<token>`).
- **Публикация**: требования рассылки готовятся из параметров заказчика (`requestMatching.service.prepare`), запись в
  журнал требований, то же уведомление модератору, что у заявки сайта.
- **Доступ** — `order_access`, пишется до отправки SMS рассылки.
- **Предложения** (`offer.service`): одно на исполнителя, версии, итог считает сервер; неизвестное даёт неполный итог,
  а не ноль. **Переписка** (`thread.service`): одна ветка на пару заявка + исполнитель, телефоны в тексте исполнителя
  скрываются. **Выбор и подтверждение** (`selection.service`): один активный выбор (уникальный ключ), сверка версий,
  срок подтверждения, контакты после подтверждения.
- **Уведомления**: событие в `outbox_events` той же транзакцией → `dealNotify.service` решает, кому и что →
  `notification_deliveries` с ключом от дублей → отправка; тихие часы, лимит, объединение совпавших событий, страница
  возврата `/t/…` (`resumeLink.service`).
- **Три входа к одной логике**: REST `/api/v1` (`apiDeal.controller`), инструменты MCP (`mcpDeal.tools.js`), страницы
  сайта (`deal.controller.js`, `deal-owner.ejs`, `deal-provider.ejs`, `public/js/deal.js`). Все вызывают `dealApi.service`.
- **ChatGPT**: инструкция сервера (`INSTRUCTIONS` в `mcp.controller.js`) ставит заявку через аккаунт первой, ссылку
  `/draft` — запасной. У каждого инструмента `securitySchemes`; без входа — ответ с `_meta["mcp/www_authenticate"]`.
  Внешние действия требуют `confirmed_by_user`.

Подробнее: [api-v1/WORKFLOWS.md](api-v1/WORKFLOWS.md), [api-v1/NOTIFICATIONS.md](api-v1/NOTIFICATIONS.md),
[api-v1/MCP_MAPPING.md](api-v1/MCP_MAPPING.md), [api-v1/BACKEND_AUDIT.md](api-v1/BACKEND_AUDIT.md).

## 5. Фоновые процессы

Все в том же процессе (`setInterval`), запускаются из `src/app.js`.

| Процесс | Как часто | Что делает |
|---|---|---|
| `dealWorker.service` | Раз в 20 с и сразу после действия | Закрытие сбора по сроку, истечение выбора и предложений, очередь событий → уведомления, отправка, чистка ключей идемпотентности |
| `oauth.service` | Раз в час | Удаляет просроченные коды и токены |
| `descriptionTranslation.service` | Периодически (если есть ключ OpenRouter) | Переводит описания исполнителей, которым перевода не хватает |
| `siteAnalytics.service` | Раз в сутки | Удаляет старые визиты |

Перезапуск безопасен: события берутся с блокировкой, обработчики идемпотентны (`dedupe_key`).

## 6. Безопасность и приватность

- **Админка**: пароль, подписанная HMAC сессия, CSRF, ограничение попыток, оповещения в Telegram о входе; вход с кодом
  из SMS на `ADMIN_PHONE` и запасной код. Без `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET` админка отвечает 503.
- **Заказчик** — секретная ссылка `/o/…` и кука владельца; **исполнитель** — личный ключ ссылки лида (хешем) или вход
  в кабинет. Пересланная ссылка исполнителя только читается.
- **Платные данные** (номер в каталоге, баланс) не попадают в HTML и JSON до оплаты.
- **Телефоны в текстах** заявок, предложений и сообщений скрываются (`phoneInText`); в режиме предложений телефон
  заказчика — только после подтверждения выбора.
- **Закрытые страницы** — `noindex` и закрыты в `robots.txt`.
- **Секреты** — только в переменных Railway; `HANDOFF.md` (локальный, с доступами) — вне git.

Подробнее: [security-audit.md](security-audit.md) (снимок 05.09.2026 и вход с SMS).

## 7. Проверки

- **Тесты**: `node --test tests/*.test.js` — 89 тестов в 88 файлах на pg-mem (база в памяти) и локальном Express, без
  настоящих SMS.
  Для API и сделки — `tests/api-v1-harness.js` (транзакции по очереди: pg-mem откатывает базу целиком).
- **Ограничения pg-mem**: нет `ANY($1::uuid[])`, коррелированных подзапросов, plpgsql, `DO`, триггеров;
  `ON CONFLICT DO NOTHING RETURNING` возвращает существующую строку; JSONB-значения по умолчанию приходят строкой. Правки
  схемы и конкурентные транзакции проверять на настоящем PostgreSQL (`embedded-postgres` во временной папке; схема
  рабочего сайта с данными, затем новая — дважды).
- **Страницы** — локально в браузере (Playwright), ширина 320–412 px на трёх языках: страница не шире экрана.
- **Тестовое окружение** — `node scripts/staging-check.js <адрес> [ключ]`.
- **Внешние сервисы** (SMS, ChatGPT, банк) — только настоящим подключением; локальные тесты их не подтверждают.
- **Стили** — после правки `npm run build`.

## 8. Выкладка и откат

- **Рабочий сайт**: отправка в `main` → Railway собирает и запускает сам. Только по слову владельца «выкладывай».
  После — статус коммита `fabulous-luck - xtender-ge` = `success` (второй статус, Vercel, — старое подключение, сайт не
  там) и ответ `https://xtender.ge/`.
- **Тестовое окружение**: отправка ветки `api-v1-stage1` → Railway `staging` собирает сам.
- **На этой машине** обычный `git push` работает (локальный помощник учётных данных репозитория); правила и запасной
  путь через API GitHub — [AGENTS.md](../AGENTS.md).
- **Схема только добавляется**, поэтому откат кода — возврат коммита; новые таблицы и колонки остаются и не мешают
  старому коду. Перед выкладкой с изменением схемы — резервная копия базы и проверка миграции на копии
  ([api-v1/BACKEND_AUDIT.md](api-v1/BACKEND_AUDIT.md), разделы 11 и 14).
- **Перед выкладкой правки, зависящей от внешнего сервиса**, — прочитать `git log` файла и заметки «проверить перед
  выкладкой» (урок инцидента SMS 20.09.2026).

## 9. Технические долги и ограничения

1. `schema.sql` выполняется при каждом старте; отдельных миграций с откатом нет.
2. Загрузки на диске контейнера (`public/uploads`); подключён ли Volume, не подтверждено. Вложения в API отложены до
   закрытого хранилища.
3. SMS-шлюз по `http://`, без отчётов о доставке; шлюз дописывает к SMS служебную строку.
4. `/health` не проверяет базу и Redis (этап 4 ТЗ).
5. Страница главной тяжёлая: около 535 КБ HTML, из них около 130 КБ — словарь переводов в коде страницы.
6. Старый код прежней вёрстки главной ещё не удалён.
7. Фоновые процессы — `setInterval` в одном процессе; при нескольких экземплярах приложения нужна проверка блокировок.
8. Подключённый к репозиторию Vercel — остаток; отключить может владелец.
9. Уязвимые версии библиотек — задача в [tasks.md](tasks.md).
