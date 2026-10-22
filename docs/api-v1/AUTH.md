# Вход OAuth для API v1 и плагина ChatGPT

Как приложение (ChatGPT, Claude, свой клиент) подключает аккаунт xtender.ge. Сделано 2026-10-23, этап 1 ТЗ «API для
плагина ChatGPT». Код: `src/services/oauth.service.js`, `src/controllers/oauth.controller.js`, `src/routes/oauth.routes.js`,
страница `src/views/oauth-authorize.ejs`, тексты `src/config/oauth-copy.js`. Тест: `tests/api-v1-auth.test.js`.

## 1. Схема

OAuth 2.1, **Authorization Code + PKCE (только S256)**, публичные клиенты без секрета. Сервер авторизации и защищённый
ресурс — один сайт: издатель `https://xtender.ge`, ресурсы `https://xtender.ge/api/v1` (REST) и `https://xtender.ge/mcp`
(MCP-адаптер, этап 5). Токен, выданный на любой из них, принимают оба.

1. Клиент читает метаданные: корневой `GET /.well-known/oauth-protected-resource` (описывает `/mcp`, его читает ChatGPT)
   или `…/api/v1` для REST, и `GET /.well-known/oauth-authorization-server`.
2. Регистрируется: `POST /oauth/register` (RFC 7591) с `redirect_uris`; получает `client_id`. Повторно не нужно.
3. Открывает человеку `GET /oauth/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope&resource`.
4. На странице xtender.ge человек вводит номер (+995), получает SMS «Xtender code: 1234. Enter it on xtender.ge to connect
   an app to your account. Never share it in a chat. Not you? Ignore this SMS.», вводит код **на этой странице** (не в
   чате), видит, что сможет приложение, и нажимает «Разрешить».
5. Сайт возвращает на `redirect_uri` с `code`, `state` и `iss` (RFC 9207). Отказ — `error=access_denied`.
6. Клиент меняет код на токены: `POST /oauth/token` `grant_type=authorization_code` с `code`, `redirect_uri`, `client_id`,
   `code_verifier` (и необязательным `resource`).
7. Вызовы API с заголовком `Authorization: Bearer <access_token>`. Через час — `grant_type=refresh_token`.

Аккаунт создаётся при первом «Разрешить» для номера, подтверждённого кодом. Отдельной регистрации заказчика нет.
Подтверждение номера пишется в журнал согласий (`sms_consent_logs`, `OAUTH_SMS_OTP_VERIFIED`, в `metadata` — клиент и
области). Это подтверждение номера, а **не** согласие с Офертой: согласие для публикации заявок — этап 2 (BACKEND_AUDIT.md,
раздел 8, вопрос 9).

## 2. Адреса

| Адрес | Что |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: [S256]`, `token_endpoint_auth_methods_supported: [none]`, `authorization_response_iss_parameter_supported: true`, `scopes_supported` |
| `GET /.well-known/oauth-protected-resource[/mcp \| /api/v1]` | RFC 9728, корневой адрес = `/mcp`: `resource`, `authorization_servers: [issuer]`, `scopes_supported`, ссылки на документацию, Политику и Оферту |
| `POST /oauth/register` | RFC 7591, JSON. `redirect_uris` (1–5), `client_name`, `scope`, `client_uri`; `token_endpoint_auth_method` — только `none`. 201 с `client_id`. 20 регистраций в час с адреса |
| `GET /oauth/authorize` | Страница входа (ka/ru/en по `ui_locales` или языку сайта), 60 открытий в час с адреса. Неизвестный клиент или адрес возврата — страница с ошибкой без перехода; остальные ошибки — переход к клиенту с `error`, `state`, `iss` |
| `POST /oauth/authorize/phone`, `/code`, `/decision` | Шаги страницы. Запрос входа живёт 15 минут в Redis и привязан к куке этой вкладки (`oauth_request`, `httpOnly`, путь `/oauth`); межсайтовый запрос — 403 |
| `POST /oauth/token` | `authorization_code` и `refresh_token`; форма или JSON. Ответ `{access_token, token_type: Bearer, expires_in, refresh_token, scope}`, `Cache-Control: no-store`. Ошибки по RFC 6749: `invalid_grant`, `invalid_request`, `invalid_client`, `invalid_scope`, `invalid_target`, `unsupported_grant_type`. 120 запросов в минуту с адреса |
| `POST /oauth/revoke` | RFC 7009: `token` (+ `client_id`). Всегда 200. Отзыв любого токена отключает всю сессию |
| `GET /api/v1/me/sessions`, `DELETE /api/v1/me/sessions/{id}` | Человек (через приложение) видит подключённые приложения и отключает любое; токены перестают работать сразу |

## 3. Адреса возврата

Клиенты регистрируются сами, поэтому принимаются только известные адреса (`oauth.service.redirectAllowed`):
`https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/<id>`,
`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`. Свои шаблоны —
`OAUTH_REDIRECT_ALLOWLIST` (через запятую, `*` — один сегмент из букв, цифр, `.`, `_`, `-`). Адреса на своём компьютере
(`http://127.0.0.1:<порт>/…`, `localhost`) — только в песочнице, при `NODE_ENV=development` или с `OAUTH_ALLOW_LOOPBACK=1`.
Адрес возврата при входе должен совпасть с зарегистрированным символ в символ.

## 4. Области доступа

Все девять областей ТЗ есть в контракте (`openapi.yaml`, `components.securitySchemes`). Метаданные объявляют и вход
разрешает **только области со сделанными операциями** (`apiConfig.activeScopes()`), сейчас `profile:read` и `profile:write`:
ChatGPT запрашивает все объявленные области, и экран согласия не должен обещать «публиковать заявки», пока API этого не умеет.
Остальные включатся сами, когда их операции в `src/config/apiCapabilities.js` станут `implemented`. Без `scope` выдаётся
`profile:read`. Запрос несуществующей или ещё не доступной области — `invalid_scope`.

| Область | Что даёт | Доступна |
|---|---|---|
| `profile:read` | Аккаунт, профиль исполнителя, подключённые приложения | да |
| `profile:write` | Имя, язык, часовой пояс; языки и приём заявок исполнителя; отключение приложений | да |
| `tenders:read`, `tenders:write`, `offers:read`, `offers:write`, `messages:read`, `messages:write`, `notifications:write` | Заявки, предложения, переписка, уведомления | этапы 2–3 |

Область проверяется вместе с ролью и доступом к объекту: `INSUFFICIENT_SCOPE` (403 с
`WWW-Authenticate: Bearer …, error="insufficient_scope", scope="…"`), `role_required:provider`, свой объект — только свой.

## 5. Токены и сессии

- Access-токен `xat_…` — 1 час; refresh-токен `xrt_…` — 30 дней; код авторизации — 2 минуты, одноразовый. В базе только
  sha256 (`oauth_tokens`, `oauth_authorization_codes`); просроченные удаляются раз в час.
- **Ротация**: каждый обмен refresh-токена выдаёт новую пару и гасит старый. Повторное предъявление уже обменянного
  refresh-токена или кода — признак кражи: сессия отключается целиком (`revoke_reason`: `refresh_reuse`, `code_reuse`).
  Обратная сторона: если клиент потерял ответ на обмен и повторил его, человеку придётся подключиться заново. Окна
  терпимости нет.
- Сессия (`oauth_grants`) — подключение аккаунта к клиенту. Отключение (`DELETE /me/sessions/{id}`, `/oauth/revoke`)
  действует сразу: токен проверяется вместе с сессией при каждом запросе.
- Запросы без токена или с неверным токеном — 401 с
  `WWW-Authenticate: Bearer resource_metadata="https://xtender.ge/.well-known/oauth-protected-resource/api/v1", error="invalid_token"`.
- Лимит — 120 запросов в минуту на сессию (429, `Retry-After`).
- Состояние аккаунта: `read_only` — токены работают на чтение, запись 403 `ACCOUNT_READ_ONLY`; `blocked` — токены и
  refresh не принимаются (401 / `invalid_grant`), все сессии отключаются в момент блокировки, страница входа показывает
  «аккаунт заблокирован» и не возвращает код приложению (`account.service.setStatus`).
- В журнал сервера не пишутся токены, коды и номера: строка запроса — метод, путь без параметров, статус; ошибки
  проходят через `redact()`. Тест проверяет журнал.

## 6. Совместимость с ChatGPT

Сверено 2026-10-23 со страницей developers.openai.com/plugins/build/auth:

| Требование ChatGPT | Как у нас |
|---|---|
| PRM с `resource` и `authorization_servers`, `issuer` совпадает побайтно | Да, тест |
| `code_challenge_methods_supported` содержит S256 | Только S256 |
| Регистрация: CIMD (предпочтительно), DCR или заранее заведённый клиент | DCR. CIMD не сделан: серверу пришлось бы скачивать документ клиента по ссылке |
| `iss` в каждом ответе авторизации при `authorization_response_iss_parameter_supported` | Да, и в ошибках |
| `resource` копируется в токен, чужой ресурс отклоняется | `oauth_grants.resource`; неизвестный — `invalid_target` |
| 401 с `WWW-Authenticate` и `resource_metadata` | Да |
| `securitySchemes` у каждого инструмента, `_meta["mcp/www_authenticate"]` в ошибке инструмента | Да, этап 1б: `get_my_account` (`oauth2`), прежние инструменты `noauth` (BACKEND_AUDIT.md, раздел 13) |
| Метаданные ресурса по корневому адресу | Корневой `/.well-known/oauth-protected-resource` описывает `/mcp` |
| Адреса возврата `connector_platform_oauth_redirect` и `connector/oauth/{callback_id}` | В списке разрешённых |
| `openid`/`email`, UserInfo — только для ограничения по рабочим доменам | Не нужно: у нас вход по телефону |

Настоящий ChatGPT к этому серверу не подключался: это этап 1б в тестовом окружении (BACKEND_AUDIT.md, раздел 13). Если ChatGPT зарегистрируется не через DCR,
а через CIMD, добавить разбор CIMD только для `https://chatgpt.com/oauth/…` (без скачивания произвольных адресов).

## 7. Пример (песочница)

```bash
node scripts/api-sandbox.js                      # http://127.0.0.1:3100, SMS — в приёмник
node scripts/api-sandbox-token.js +995500000001  # проходит вход как человек и печатает токены
curl -s http://127.0.0.1:3100/api/v1/me -H "Authorization: Bearer xat_…"
curl -s -X POST http://127.0.0.1:3100/oauth/token -d grant_type=refresh_token -d client_id=xtc_… -d refresh_token=xrt_…
curl -s -X POST http://127.0.0.1:3100/oauth/revoke -d token=xat_… -d client_id=xtc_…
```

Код из SMS в песочнице: `GET /api/v1/sandbox/sms?phone=%2B995500000001` (на рабочем сайте этого адреса нет — 404).
