# Xtender API v1

REST API xtender.ge для плагина ChatGPT (MCP-адаптер `/mcp`) и любых других клиентов. Префикс `/api/v1`, только JSON
UTF-8. Сделано (ветка `api-v1-stage1`, не выложено): обнаружение возможностей, вход, аккаунт, профиль исполнителя,
каталог (этап 1) и вся сделка — заявки, модерация, предложения, сравнение, выбор, подтверждение, переписка, SMS-уведомления
(этапы 2–3). Не сделаны вложения, проекты и долгие операции: в [openapi.yaml](openapi.yaml) они `x-xtender-status: planned`.

- Сделка: [WORKFLOWS.md](WORKFLOWS.md); уведомления: [NOTIFICATIONS.md](NOTIFICATIONS.md); инструменты ChatGPT:
  [MCP_MAPPING.md](MCP_MAPPING.md); проверка владельцем: [OWNER_CHECK.md](OWNER_CHECK.md).

- Контракт: [openapi.yaml](openapi.yaml) (весь, собирается `node scripts/build-openapi-yaml.js` из `src/config/openapiV1.js`);
  сервер отдаёт только сделанное на `GET /api/v1/openapi.json`.
- Вход: [AUTH.md](AUTH.md). Обследование, решения и план: [BACKEND_AUDIT.md](BACKEND_AUDIT.md).
- Production: `https://xtender.ge/api/v1` (после выкладки). Песочница: `http://127.0.0.1:3100/api/v1`.

## 1. Песочница

```bash
node scripts/api-sandbox.js
```

Тот же `src/app.js` на базе и Redis в памяти, с `XTENDER_SANDBOX=1`: ни одна SMS и ни одно сообщение Telegram не уходят,
SMS складываются в `GET /api/v1/sandbox/sms`. Продовый `.env` не используется. Данные (выдуманные, с пометкой SANDBOX):

| Номер | Кто |
|---|---|
| `+995500000001` | Заказчик (профиля исполнителя нет) |
| `+995500000002` | Исполнитель «Грузчики», Тбилиси, ka/ru, активен |
| `+995500000003` | Исполнитель «Перевозки», кузов L закрытый с гидробортом, ru/en, активен |
| `+995500000004` | Исполнитель «Вывоз мусора», на модерации |
| `+995500000005` | Исполнитель «Грузчики», Тбилиси, ru/en, активен (второй — для сравнения предложений) |
| `+995500000006` | Исполнитель «Вывоз мусора», Тбилиси, до 4 м³, самосвал, ka/ru, активен |

Токен без браузера: `node scripts/api-sandbox-token.js +995500000002 "profile:read profile:write"` — проходит тот же вход,
что человек (регистрация клиента, PKCE, номер, код из приёмника, «Разрешить»). В браузере — откройте адрес входа из
[AUTH.md](AUTH.md), код возьмите в приёмнике.

Отдельная песочница на сервере: та же сборка с `XTENDER_SANDBOX=1`, своими `DATABASE_URL` и `REDIS_URL`, без
`SMS_GATEWAY_*` и `TELEGRAM_BOT_TOKEN`, с `DOMAIN` своего адреса. Пока не развёрнута (решение владельца).

## 2. Общие правила

- **Ответ** всегда содержит `request_id`; заголовки `X-Request-Id` и `X-Xtender-Environment: production|sandbox`.
- **Ошибка**: `{"error": {"code", "message", "fields"?: [{"path","code"}], "retryable"}, "request_id"}`. Коды: 400 `INVALID_JSON`,
  `INVALID_REQUEST`, `INVALID_CURSOR`; 401 `UNAUTHORIZED` (+ `WWW-Authenticate`); 403 `INSUFFICIENT_SCOPE`,
  `ACCOUNT_READ_ONLY`, `PROVIDER_BLOCKED`; 404 `NOT_FOUND`, `CATEGORY_NOT_FOUND`, `PROVIDER_PROFILE_NOT_FOUND`; 409
  `PROVIDER_REGISTRATION_REQUIRED`, `SNAPSHOT_CHANGED`; 412 `VERSION_MISMATCH` (+ `current_version`); 422 `VALIDATION_FAILED`
  с полями; 428 `PRECONDITION_REQUIRED`; 429 `RATE_LIMITED` (+ `Retry-After`); 500 `INTERNAL_ERROR`. Сообщения
  по-английски — их читает модель; коды стабильны.
- **Язык** ответа: `?lang=ka|ru|en`, иначе язык аккаунта, иначе английский. Названия хранятся на трёх языках, перевода
  на лету нет; исходный текст исполнителя отдаётся рядом с переводом (`description.original_text`).
- **Версии**: правка требует `If-Match` с версией из `ETag` (или поля `version`). Без заголовка — 428, со старой версией —
  412: перечитайте объект и повторите.
- **Списки**: `limit` (1–100, по умолчанию 20), `cursor` → `next_cursor`, `has_more`. Курсор привязан к запросу и к
  версии данных: курсор от другого запроса — 400, данные изменились за время листания — 409 `SNAPSHOT_CHANGED`,
  начните сначала. Первая страница — не весь список, пока `has_more = true`.
- **Время** — RFC 3339 (UTC с `Z`); часовой пояс аккаунта по умолчанию `Asia/Tbilisi`. **Деньги** (этап 2) — целые тетри.
- **Неизвестно** — `null` или явная причина, никогда не ноль и не пустой список «на всякий случай».
- **Кеш**: личные ответы — `Cache-Control: private, no-store`; справочники без токена — `public` на 60–300 секунд.
  Каталог читается из базы при каждом запросе; число исполнителей — до 5 минут (`checked_at`).
- **GET ничего не меняет.** Действия с внешним эффектом (публикация, предложение, выбор, сообщение) — POST с
  `Idempotency-Key`; публикация и выбор — ещё и с `confirmed_by_user: true`.
- **Деньги** — целые тетри (`*_minor`); неизвестная сумма — `null` с причиной, итог тогда `incomplete`.

## 3. Методы этапа 1

Во всех методах аккаунт берётся из токена: полей «чей это объект» во входных данных нет.

| Метод | Кто и зачем | Обязательно | Что произошло в мире | Повтор | Когда перечитать |
|---|---|---|---|---|---|
| `GET /capabilities` | Любой; с токеном — ещё и что доступно этому аккаунту | — | Ничего | Безопасен | При смене `capabilities_version` или `catalog_version` |
| `GET /me` | Подключённый аккаунт, `profile:read` | — | Ничего | Безопасен | Перед правкой (версия) |
| `PATCH /me` | Свой аккаунт, `profile:write`, аккаунт активен | `If-Match`; поля `display_name`, `locale`, `timezone` | Изменены настройки аккаунта; рассылки и SMS не затронуты | С той же версией второй раз — 412: значит, первый прошёл, перечитайте | После 412 |
| `GET /me/provider-profile` | Исполнитель, `profile:read` | — | Ничего | Безопасен | Перед правкой |
| `PUT /me/provider-profile` | Исполнитель, `profile:write`, не заблокирован | `If-Match`; меняются `languages`, `availability_status`; остальные поля можно прислать без изменений | `unsubscribed` — новые заявки этому исполнителю больше не рассылаются (каталог не меняется); языки влияют на рассылку по языку. Правка видна в админке | Как у PATCH | После 412; модерируемые поля меняет модератор (422 `MODERATOR_ONLY`) |
| `GET /me/sessions` | Свой аккаунт | — | Ничего | Безопасен | — |
| `DELETE /me/sessions/{id}` | Свой аккаунт, `profile:write` | id своей сессии | Приложение отключено, его токены не работают | Повтор — 404 (уже отключено) | — |
| `GET /categories` | Любой | — (`q` до 300 знаков) | Ничего | Безопасен | При смене `catalog_version` |
| `GET /categories/{id}/schema` | Любой | id категории | Ничего | Безопасен | При смене `schema_version` |
| `GET /locations`, `GET /units` | Любой | — | Ничего | Безопасен | Редко |

### Каталог: как читать ответ

- `q` — потребность обычными словами: «спустить мешки с мусором со второго этажа», «მუშები ავეჯის გადასატანად»,
  «need a van to move a sofa», «mushebi». Поиск без ИИ: грузинский, русский и латиница сводятся к одной латинице,
  сравнивается начало слова (слово из трёх букв — только целиком). Словарь — названия, описания и слова поиска категорий
  из `/admin/categories` (ka/ru/en и латиница; прежние слова из кода перенесены туда при старте) и слова особенностей
  (самосвал, гидроборт) из `src/config/service-search-words.js`. Правка слов меняет `catalog_version`.
- `match_status`: `none` — ничего не подошло, категорию **не придумывать**; `matched` — одна; `ambiguous` — несколько
  (задаче нужны несколько услуг или человеку надо выбрать). `matched_terms` — слова запроса, которые привели к категории;
  `match_rank` — порядок, не вероятность.
- `availability` для `location_id`: `supported`, `unsupported` (`city_not_served`, `category_inactive`), `unknown`
  (`location_not_specified`, `city_required` для страны). `supply_status`: `providers_present` с числом одобренных
  исполнителей в каталоге города, `none_known`, `unknown`. Поддержанная категория не обещает свободного исполнителя, цену
  или отклик.
- Схема категории — JSON Schema 2020-12 параметров заявки: характеристики услуги с правилом подбора
  (`x-xtender-maps-to`: с какой характеристикой исполнителя и по какому правилу сравнивается; не названное не заполнять,
  `false` — не «нет», а «не требуется»), `x-xtender-unit` — код единицы из `listUnits`. `required_for_publish` — что
  нужно для публикации (задаёт администратор). Выключенная категория не предлагается, но её схема читается. Как параметры
  становятся требованиями рассылки и что значит оценка числа исполнителей — [WORKFLOWS.md](WORKFLOWS.md), разделы 3–5.

### Профиль исполнителя

Роль исполнителя — профиль в `masters` с тем же номером. API её не выдаёт: регистрация на `/join` (409
`PROVIDER_REGISTRATION_REQUIRED` с `registration_url`). Через API исполнитель меняет только то, что меняет сам в кабинете:
языки общения и приём новых заявок. Услуги, характеристики, города, описание и имя — модератор. `rating` — среднее
одобренных модератором отзывов или `null`; выдуманного рейтинга нет. `version` — непрозрачная строка, меняется при любой
правке профиля, откуда бы она ни пришла.

### Сделка (этапы 2–3)

Все методы — в [openapi.yaml](openapi.yaml) (`x-xtender-status: implemented`), правила — [WORKFLOWS.md](WORKFLOWS.md).
Коротко: заказчик `POST /tenders` → `POST /tenders/{id}/validate` → `POST /tenders/{id}/publish` (первый раз — 409
`CONSENT_REQUIRED` со ссылкой на страницу согласия) → модератор рассылает → `GET /tenders/{id}/comparison-data` →
`POST /tenders/{id}/selection` → исполнитель `POST /offers/{id}/accept-selection` → `POST /tenders/{id}/complete`.
Исполнитель: `GET /opportunities`, `POST /tenders/{id}/threads`, `POST /tenders/{id}/offers`, `POST /offers/{id}/submit`.
Вопросы — `/threads/{id}/messages`, SMS — `/me/notification-preferences`, `/tenders/{id}/notification-subscription`,
ссылка для нового чата — `POST /tenders/{id}/resume-link`.

## 4. Примеры

```bash
B=http://127.0.0.1:3100/api/v1
curl -s "$B/capabilities?lang=ru"
curl -s -G "$B/categories" --data-urlencode "q=нужны 2 грузчика на переезд" --data-urlencode "location_id=city:tbilisi" --data-urlencode "lang=ru"
curl -s "$B/categories/movers/schema?lang=en"
curl -s "$B/locations?parent_id=city:tbilisi&limit=100"
T=xat_…   # node scripts/api-sandbox-token.js +995500000002
curl -s -i "$B/me/provider-profile" -H "Authorization: Bearer $T"          # ETag: "pv_…"
curl -s -X PUT "$B/me/provider-profile" -H "Authorization: Bearer $T" -H 'If-Match: "pv_…"' \
  -H 'Content-Type: application/json' -d '{"languages":["ka","ru","en"],"availability_status":"available"}'
```

В Git Bash на Windows кириллицу и грузинский в `curl --data-urlencode` передавайте из файла или из Node: оболочка
портит кодировку аргументов (ответ будет `none`).

## 5. Проверка

```bash
node --test tests/api-v1-*.test.js tests/deal-*.test.js   # pg-mem; api-v1-sandbox запускает scripts/api-sandbox.js целиком
API_TEST_DATABASE_URL=postgres://… node tests/api-v1-profile.test.js   # то же на настоящем Postgres (пустая база)
node scripts/build-openapi-yaml.js       # после правки src/config/openapiV1.js; тест сверяет файл
```

## 6. Файлы

| Файл | Что |
|---|---|
| `src/routes/apiV1.routes.js`, `src/controllers/apiV1.controller.js` | Маршруты и обработчики `/api/v1` |
| `src/middleware/apiV1.js` | `request_id`, ошибки, токен и области, лимит, `If-Match` |
| `src/services/apiCatalog.service.js` | Поиск категорий, схема, версии, география, наличие исполнителей |
| `src/services/providerProfileApi.service.js`, `src/services/account.service.js` | Профиль исполнителя, аккаунт и роли |
| `src/services/oauth.service.js`, `src/controllers/oauth.controller.js`, `src/views/oauth-authorize.ejs` | Вход OAuth |
| `src/config/apiV1.js`, `src/config/apiCapabilities.js`, `src/config/units.js`, `src/config/openapiV1.js` | Константы, действия, единицы, контракт |
| `scripts/api-sandbox.js`, `scripts/api-sandbox-token.js`, `scripts/build-openapi-yaml.js` | Песочница, токен, сборка YAML |
| `src/controllers/apiDeal.controller.js`, `src/services/dealApi.service.js` | REST сделки и общий слой для REST и MCP |
| `src/services/tender.service.js`, `offer.service.js`, `selection.service.js`, `thread.service.js` | Заявка, предложения, выбор, переписка |
| `src/services/orderAccess.service.js`, `outbox.service.js`, `dealNotify.service.js`, `dealWorker.service.js`, `resumeLink.service.js`, `accountConsent.service.js` | Доступ, очередь событий, уведомления, фоновая работа, ссылка возврата, согласие |
| `src/controllers/deal.controller.js`, `src/views/partials/deal-*.ejs`, `src/views/deal-page.ejs`, `public/js/deal.js` | Сделка на сайте, `/consent`, `/t` |
| `src/controllers/mcpDeal.tools.js` | Инструменты MCP для сделки |
| `src/config/deal.js`, `src/config/deal-copy.js`, `src/config/requestFields.js` | Правила, тексты ka/ru/en, параметры заявки по категориям |
| `src/services/requestMatching.service.js` | Параметры заказчика → требования рассылки, оценка числа подходящих, журнал правок |
| `src/config/categoryTexts.js` | Описания и слова поиска категорий (база, прежние значения из кода) |
| `scripts/staging-check.js` | Проверка развёрнутого тестового окружения перед подключением ChatGPT |
| `tests/api-v1-*.test.js`, `tests/deal-*.test.js`, `tests/api-v1-harness.js` | Тесты и общий стенд |

Переменные окружения: `XTENDER_SANDBOX=1` (песочница), `SANDBOX_REAL_SMS_NUMBERS` (номера, на которые в песочнице код
входа уходит настоящей SMS), `SANDBOX_REAL_DEAL_SMS=1` (туда же — уведомления сделки), `SANDBOX_SEED=1` (тестовые
исполнители в тестовом окружении), `SANDBOX_SINK_KEY` (ключ приёмника SMS), `PUBLIC_BASE_URL` (полный адрес с протоколом, если
не `https://$DOMAIN`), `OAUTH_REDIRECT_ALLOWLIST`, `OAUTH_ALLOW_LOOPBACK=1`. Тестовое окружение на сервере —
[BACKEND_AUDIT.md](BACKEND_AUDIT.md), раздел 13.
