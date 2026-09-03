# Согласия на SMS + юридические документы

Справочник по подсистеме: журнал согласий (`sms_consent_logs`), Публичная оферта
(`/terms`), Политика конфиденциальности (`/privacy`), их администрирование и выгрузка.

Зачем: Закон Грузии «О защите персональных данных» + требования SMS-операторов —
нужно доказуемое, информированное согласие исполнителя на платные SMS-уведомления и
неизменяемый цифровой след (Double Opt-In).

---

## 1. Юридические документы

### Где лежит текст

| Что | Файл | Что править |
|---|---|---|
| Текст Оферты и Политики, ka/ru/en | `src/config/legal-content.js` | массивы `terms.body.{ka,ru,en}` и `privacy.body.{ka,ru,en}`. Блок = `{ h: 'заголовок' }` \| `{ p: 'абзац' }` \| `{ ul: ['пункт', …] }` \| `{ requisites: true }` (сюда подставляются реквизиты) |
| Даты «последнее обновление» | `src/config/legal-content.js` | `terms.updated`, `privacy.updated` |
| Подписи полей реквизитов, текст «уточняется…», подписи «Версия / Обновлено» | `src/config/legal-content.js` | `REQUISITE_LABELS`, `REQUISITE_PENDING`, `LABELS` |
| **Версии документов** | `src/config/legal.js` | `TERMS_VERSION`, `PRIVACY_VERSION` |
| **Реквизиты юр. лица** | `src/config/legal.js` | `SERVICE_REQUISITES` |
| Тайтлы / H1 / meta-описания страниц | `src/config/i18n.js` | `terms_page_title`, `terms_headline`, `privacy_page_title`, `privacy_headline`, `meta_description_terms`, `meta_description_privacy` (по разу в блоках ka/ru/en) |
| Текст чекбоксов на `/join` | `src/config/i18n.js` | `join_terms_label` / `join_terms_link` / `join_err_terms_required` и `join_privacy_*` (по разу в ka/ru/en) |
| Рендер страниц | `src/views/terms.ejs`, `privacy.ejs` — тонкие обёртки; общий рендер — `src/views/_legal-doc.ejs` |
| Роуты | `src/routes/public.routes.js` — `GET /terms`, `GET /privacy` (+ локали `/ru/…`, `/en/…`) |
| sitemap | `public/sitemap.xml` — по 3 URL на документ |

### Правило версий

`TERMS_VERSION` / `PRIVACY_VERSION` (`src/config/legal.js`, формат `vMAJOR.MINOR-YYYY-MM-DD`)
**поднимать при любом изменении текста соответствующего документа** в `legal-content.js`.
По этой строке в журнале согласий видно, какую редакцию принял человек. Понизить/
переиспользовать версию нельзя.

Текст чекбоксов на `/join` (`join_terms_label` / `join_privacy_label` в i18n) отдельно
**не версионируется** — он сохраняется дословно в `consent_text_snapshot` на каждую
регистрацию, поэтому правки формулировок для ясности не требуют бампа версии (но должны
оставаться согласованными с документом).

Приоритет языков: при расхождении версий юридически приоритетна **грузинская** (п. 1.6
оферты). Значит — грузинский текст должен быть вычитан носителем/юристом.

### Реквизиты юр. лица

`SERVICE_REQUISITES` в `src/config/legal.js` — единственное место. Незаполненные поля
(`null`) рендерятся на странице как «уточняется после регистрации юр. лица»
(`REQUISITE_PENDING`). `email` и `website` заданы; `entityName` / `idCode` /
`legalAddress` ждут данных реальной компании.

При заполнении реквизитов — считать это изменением документа и поднять версии.

### Cookie-баннер не нужен

Все куки сайта — strictly-necessary (`lang`, `master_session`, `order_<token>`,
`my_orders`, админ-сессия). Достаточно раскрытия в Политике (п. 2.2), баннер согласия
по практике PDPS/EU для необходимых куки не требуется.

---

## 2. Журнал согласий `sms_consent_logs`

### Схема

Определена в `schema.sql` (блок «Журнал согласий на SMS»). Ключевое:

- `BIGSERIAL id`, `event_type`, `phone_number`, nullable `master_id` / `order_id`
  (**без FK** — журнал переживает удаление профиля/заявки), `purpose`,
  `ip_address` / `user_agent` / `x_forwarded_for`, `otp_reference_id` + `provider` +
  `provider_response` (JSONB, сырой ответ шлюза), `otp_code_hash` / `message_body_hash`
  (SHA-256, **сам код/текст не хранятся**), `terms_version`, `consent_language`,
  `consent_text_snapshot`, `metadata` (JSONB), `timestamp_utc`.
- 5 индексов: phone / master / event / ts / ref.

### Иммутабельность

Таблица строго **append-only**: приложение делает только `INSERT`. На реальном Postgres
это закреплено триггером `trg_sms_consent_logs_append_only` из **`schema.postgres.sql`**
(отдельный файл, потому что pg-mem не тянет plpgsql; `runMigrations()` в `app.js`
накатывает его после `schema.sql`, dev-server пропускает через `SKIP_DB_MIGRATIONS`).

`UPDATE` / `DELETE` из этой таблицы на проде вернут ошибку — это by design.

### Хэш кода

`otp_code_hash` = `SHA-256(CONSENT_HASH_PEPPER + ':' + код)`. `CONSENT_HASH_PEPPER` —
опциональная env-переменная; без неё 4-значный код перебирается по дампу БД за 10k
хэшей, перчинка это исключает. Один и тот же хэш на строках `SMS_OTP_SENT` и
`*_OTP_VERIFIED` доказывает «код, который отправили = код, который ввели».

### Типы событий (`event_type`)

| event_type | Когда | consent_text_snapshot |
|---|---|---|
| `CONSENT_SMS_OTP_VERIFIED` | подтверждение кода на `/join` — **юридический момент согласия** | оба текста чекбоксов + версии + абсолютные ссылки |
| `AUTH_SMS_OTP_VERIFIED` | подтверждение кода при входе в кабинет `/master` | `NULL` (на экране входа согласия нет) |
| `ORDER_SMS_OTP_VERIFIED` | подтверждение кода клиентом при создании заявки | `NULL` |
| `REVIEW_SMS_OTP_VERIFIED` | подтверждение кода клиентом для отзыва | `NULL` |
| `SMS_OTP_SENT` | факт отправки OTP-SMS (любой flow) | `NULL` |
| `LEAD_SMS_SENT` | лид-уведомление исполнителю | `NULL` |
| `TX_SMS_SENT` | прочие транзакционные (подтверждение регистрации, пинок «пополни», приглашение на отзыв) | `NULL` |

`terms_version` проставляется на **всех** `*_OTP_VERIFIED`, `consent_text_snapshot` и
`metadata` (структурно) — только на `CONSENT_SMS_OTP_VERIFIED`.

### Точки записи (код)

| Что пишет | Где | Режим |
|---|---|---|
| `recordConsentVerified` | `otp.service.verifyCode()` (после проверки кода, **до** его инвалидации) | для `/join` — `strict: true` (сбой записи → verify отдаёт 500, регистрация не идёт); для входа/заявки/отзыва — best-effort |
| `recordOtpSent` | `otp.service.sendCode()` после отправки | best-effort |
| `recordSmsDelivery` | `sms.service.send()` (единый choke-point всех не-OTP SMS) | best-effort, fire-and-forget |

`otp.service` кладёт `otp_meta:<purpose>:<phone>` в Redis на шаге `sendCode` (provider
ref + orderId), чтобы шаг `verifyCode` (отдельный HTTP-запрос) перенёс их на строку
согласия.

### Что записывается при регистрации на `/join`

1. `/api/masters/otp/send` → `SMS_OTP_SENT` (phone, purpose `master`, IP/UA, хэш кода,
   `otp_reference_id` от шлюза).
2. `/api/masters/otp/verify` (тело содержит `termsAccepted` + `privacyAccepted`, оба
   обязательны) → `CONSENT_SMS_OTP_VERIFIED`:
   - `ip_address` (`req.ip`, за `trust proxy`), `user_agent`, `x_forwarded_for` (сырой);
   - `terms_version` + `consent_language`;
   - `consent_text_snapshot` — оба текста чекбоксов + `[версия]` + абсолютные
     `https://<host>/terms` и `/privacy` (реальный протокол+домен запроса);
   - `metadata` JSONB — `{ terms_version, privacy_version, terms_url, privacy_url,
     consent_language, terms_accepted: true, privacy_accepted: true }`;
   - `otp_code_hash` от введённого кода, `otp_reference_id` — из `otp_meta` в Redis.
3. `/api/masters/register` → создаётся `masters` (с `terms_accepted_at = NOW()`),
   подтверждающая SMS пишет `TX_SMS_SENT` (уже с `master_id`).

`master_id` на строке `CONSENT_SMS_OTP_VERIFIED` = `NULL` (профиля ещё нет). Связь с
профилем в выгрузке — джойном `phone_number ↔ masters.phone`.

---

## 3. Просмотр и выгрузка

### `/admin/consent` (в админке)

- **Без параметра** — последние 150 подтверждённых согласий (`*_OTP_VERIFIED`): время,
  тип, номер, профиль, версии, IP.
- **`?phone=<номер>`** (любой формат записи) — карточка Double Opt-In (дата, версии
  оферты/политики, IP, User-Agent, X-Forwarded-For, снимок текста, `otp_reference_id`,
  SHA-256 кода) + профиль(и) + полная таблица всех событий по номеру.
- Кнопка **«Скачать JSON»** → `GET /admin/consent/export?phone=<номер>` — файл
  `sms-consent-<цифры>.json`, `Content-Disposition: attachment`.
- Ссылка «Журнал согласий →» есть и в карточке специалиста (`/admin/masters/:id`).

### CLI (на сервере)

```
node scripts/export-consent-log.js +9955XXXXXXXX
node scripts/export-consent-log.js --master 42
node scripts/export-consent-log.js +9955XXXXXXXX > consent.json
```

Тот же JSON, что отдаёт `/admin/consent/export`.

### Формат отчёта (`consentLog.service.exportForPhone`)

```jsonc
{
  "report_type": "sms_consent_audit",
  "generated_at_utc": "…",
  "terms_version_current": "v1.2-2026-09-03",
  "privacy_version_current": "v1.2-2026-09-03",
  "query": { "phone": "…", "matched_phone_formats": ["+995…", "995…", "…"] },
  "subject": {
    "profiles": [ { …masters row…, "has_explicit_sms_consent": true } ],
    "double_opt_in": {
      "status": "VERIFIED",            // | NO_CONSENT_RECORD_FOR_EXISTING_PROFILE | NO_RECORD
      "verified_at_utc": "…",
      "terms_version": "v1.2-2026-09-03",
      "privacy_version": "v1.2-2026-09-03",
      "consent_language": "ru",
      "consent_text_shown": "[v1.2…] …оферта… — https://xtender.ge/terms\n[v1.2…] …политика… — https://xtender.ge/privacy",
      "consent_details": { "terms_accepted": true, "privacy_accepted": true, … },
      "ip_address": "…", "user_agent": "…", "x_forwarded_for": "…",
      "otp_reference_id": "…", "otp_code_sha256": "…", "log_row_id": 4
    }
  },
  "event_count": 3,
  "events": [ …все строки журнала по номеру, хронологически… ]
}
```

`status` без строки `CONSENT_SMS_OTP_VERIFIED`:
- `NO_CONSENT_RECORD_FOR_EXISTING_PROFILE` — профиль есть, согласия нет (заведён до
  внедрения журнала 2026-09-03 либо иным каналом); в блоке — `latest_phone_verification`;
- `NO_RECORD` — ни профиля, ни событий.

---

## 4. Конфигурация

| Переменная / константа | Где | Назначение |
|---|---|---|
| `CONSENT_HASH_PEPPER` | env (`.env`, `.env.example`) | перчинка к SHA-256 OTP-кода; пусто = чистый SHA-256 |
| `TERMS_VERSION`, `PRIVACY_VERSION` | `src/config/legal.js` | версии документов, пишутся в журнал |
| `SERVICE_REQUISITES` | `src/config/legal.js` | реквизиты юр. лица для `/terms` и `/privacy` |
| `SKIP_DB_MIGRATIONS` | env | пропускает `schema.sql` + `schema.postgres.sql` (нужно только `dev-server.js`) |

---

## 5. Открытые вопросы / операционные заметки

- **Тариф лида.** Текст оферты цену не называет («согласно тарифу»). Код списывает
  **50 тетри** (0.50 GEL) — `COST_PER_NOTIFICATION_TETRI` в `order.service.js`,
  `LEAD_PRICE_TETRI` ×2 в контроллерах, `LOW_BALANCE_NUDGE_TETRI = 250` (~5 лидов),
  строки i18n `join_subtitle` / `join_payment_desc` / `meta_description_join` ×3 языка.
  Изменён с 30 → 50 тетри 2026-09-03. Все эти места держать в синхроне.
- **Грузинский текст v1.2** содержит опечатки автора комплекта (`ინფრომაციულ`,
  `წინარასწარ`, `სმიტება`, `სჭრის თანხა`, `მონიშნვა`) — перенесён verbatim, нужна
  вычитка носителем (ka — приоритетная версия).
- **Экран входа в кабинет `/master`** согласия не показывает → `AUTH_SMS_OTP_VERIFIED`
  идёт без `consent_text_snapshot` (by design). Если нужно «каждый вход =
  переподтверждение» — добавить строку согласия на экран входа.
- **Легаси-мастера до 2026-09-03** — без записи согласия; подделать её нельзя
  (append-only). Вариант — разовый прогон переподтверждения через `/join`.
- **Тексты писала сторонняя LLM, живой юрист не проверял.**
- `schema.postgres.sql` (триггер) на реальном Postgres проверяется по факту старта
  приложения (`runMigrations` упадёт → `process.exit(1)`).

---

## 6. Локальное тестирование

Паттерн — `dev-server.js` (pg-mem + ioredis-mock). Триггер append-only на pg-mem не
накатывается, так что иммутабельность локально не проверить — только на проде.

Быстрый сквозной тест: `/api/masters/otp/send` → достать код из лога
(`[SMS DEV MODE] … Code: NNNN`) → `/api/masters/otp/verify` с
`{termsAccepted:true, privacyAccepted:true}` → `/api/masters/register` → войти в
`/admin` и открыть `/admin/consent?phone=<номер>` или дёрнуть `/admin/consent/export`.
