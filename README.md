# Xtender

**xtender.ge** соединяет заказчиков в Грузии с независимыми местными исполнителями — грузчики, перевозки, вывоз мусора
и другие услуги. Заказчик пишет задачу один раз (на сайте или в своём ChatGPT), модератор проверяет её, подходящие
исполнители получают заявку и откликаются. Заказчику бесплатно; платит исполнитель, сейчас идёт бесплатный период.

Рабочий сайт: **https://xtender.ge**

## Документация

| Что | Где |
|---|---|
| Проект целиком: идея, гипотезы, принципы, состояние, следующие шаги | [docs/project-overview.md](docs/project-overview.md) |
| Как устроено внутри: данные, логика, окружения, выкладка | [docs/technical-overview.md](docs/technical-overview.md) |
| Карта всех документов и правила, как их вести | [docs/README.md](docs/README.md) |
| Живой список задач и протокол работы | [docs/tasks.md](docs/tasks.md) |
| Правила для сессий разработки | [AGENTS.md](AGENTS.md) |

## Запуск на своём компьютере

```
npm install
node dev-server.js
```

Сайт на `localhost:3000` с базой и Redis в памяти (pg-mem, ioredis-mock): SMS не отправляются, а пишутся в консоль,
при старте создаются 50 демо-исполнителей.

Песочница API и сделки для ChatGPT — `node scripts/api-sandbox.js` (порт 3100, тестовые заказчик и исполнители,
приёмник SMS `/api/v1/sandbox/sms`).

**Никогда не запускайте `npm start` или `node src/app.js` с рабочим `.env`**: приложение подключится к рабочей базе и
отправит настоящие SMS. Переменные окружения — [docs/technical-overview.md](docs/technical-overview.md), раздел 2, и
`.env.example`.

## Проверки

```
node --test tests/*.test.js   # все тесты (pg-mem, без настоящих SMS)
npm run build                 # после правки стилей
```

Правки схемы базы и конкурентные транзакции дополнительно проверяются на настоящем PostgreSQL; ограничения pg-mem —
[docs/technical-overview.md](docs/technical-overview.md), раздел 7.

## Выкладка

Railway, проект `fabulous-luck`: отправка в ветку `main` сама выкладывает рабочий сайт. Выкладка — только по явному
слову владельца. После неё проверить статус коммита `fabulous-luck - xtender-ge` = `success` и ответ
`https://xtender.ge/`. Ветка `api-v1-stage1` собирается в тестовом окружении `staging`. Подробно —
[docs/technical-overview.md](docs/technical-overview.md), раздел 8, и [AGENTS.md](AGENTS.md).
