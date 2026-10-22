// Общие константы API v1 (/api/v1) и входа OAuth для плагина ChatGPT и других клиентов.
// Описание — docs/api-v1/README.md и docs/api-v1/AUTH.md.
const { getBaseUrl } = require('./url');

const API_VERSION = '1';
const PREFIX = '/api/v1';

// Области доступа из ТЗ (раздел 4). Подписи — для экрана согласия на /oauth/authorize (ka/ru/en).
const SCOPES = {
  'profile:read': { ru: 'Видеть ваш профиль: имя, язык, роли', ka: 'თქვენი პროფილის ნახვა: სახელი, ენა, როლები', en: 'See your profile: name, language, roles' },
  'profile:write': { ru: 'Менять настройки профиля: имя, язык, часовой пояс, языки и приём заявок исполнителя', ka: 'პროფილის პარამეტრების შეცვლა: სახელი, ენა, დროის სარტყელი, შემსრულებლის ენები და განაცხადების მიღება', en: 'Change profile settings: name, language, time zone, provider languages and request intake' },
  'tenders:read': { ru: 'Видеть ваши заявки', ka: 'თქვენი განაცხადების ნახვა', en: 'See your requests' },
  'tenders:write': { ru: 'Готовить и публиковать заявки — только после вашего подтверждения', ka: 'განაცხადების მომზადება და გამოქვეყნება — მხოლოდ თქვენი დადასტურების შემდეგ', en: 'Prepare and publish requests, only after you confirm' },
  'offers:read': { ru: 'Видеть предложения по вашим заявкам и ваши предложения', ka: 'თქვენს განაცხადებზე მიღებული და თქვენი შეთავაზებების ნახვა', en: 'See offers on your requests and your own offers' },
  'offers:write': { ru: 'Готовить и отправлять предложения, выбирать исполнителя — только после вашего подтверждения', ka: 'შეთავაზებების მომზადება და გაგზავნა, შემსრულებლის არჩევა — მხოლოდ თქვენი დადასტურების შემდეგ', en: 'Prepare and send offers, choose a provider, only after you confirm' },
  'messages:read': { ru: 'Читать переписку по вашим заявкам', ka: 'თქვენი განაცხადების მიმოწერის კითხვა', en: 'Read messages about your requests' },
  'messages:write': { ru: 'Отправлять сообщения по вашим заявкам — только после вашей команды', ka: 'შეტყობინებების გაგზავნა თქვენს განაცხადებზე — მხოლოდ თქვენი თხოვნით', en: 'Send messages about your requests, only when you ask' },
  'notifications:write': { ru: 'Менять настройки уведомлений', ka: 'შეტყობინებების პარამეტრების შეცვლა', en: 'Change notification settings' },
};
const SCOPE_NAMES = Object.keys(SCOPES);
// Если клиент не назвал области, выдаём только чтение профиля.
const DEFAULT_SCOPE = 'profile:read';

// Области, у которых уже есть сделанные операции. Только их объявляют метаданные и только их можно запросить при
// входе: ChatGPT запрашивает все объявленные области, и экран согласия не должен обещать «публиковать заявки»,
// пока таких операций нет. Остальные области ТЗ включатся сами, когда их операции будут помечены implemented.
function activeScopes() {
  const { ACTIONS } = require('./apiCapabilities');
  const used = new Set(ACTIONS.filter((action) => action.implemented).flatMap((action) => action.scopes));
  return SCOPE_NAMES.filter((scope) => used.has(scope));
}

// Защищённые ресурсы (RFC 8707 / RFC 9728): REST API и будущий MCP-адаптер на том же сайте. Токен
// выдаётся на один из них и принимается обоими: это один сервис и один владелец данных.
function resources() {
  const base = getBaseUrl();
  return { api: base + PREFIX, mcp: base + '/mcp' };
}
function isResource(value) {
  return Object.values(resources()).includes(value);
}

// Песочница: отдельная установка без настоящих SMS и рассылок (XTENDER_SANDBOX=1). Видна в каждом ответе API.
function isSandbox() {
  return process.env.XTENDER_SANDBOX === '1' || process.env.XTENDER_SANDBOX === 'true';
}
function environment() {
  return isSandbox() ? 'sandbox' : 'production';
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 120;
// Запросов API в минуту на одну сессию; при превышении — 429 с Retry-After.
const RATE_LIMIT_PER_MINUTE = 120;

module.exports = {
  API_VERSION, PREFIX, SCOPES, SCOPE_NAMES, DEFAULT_SCOPE, activeScopes, resources, isResource, isSandbox, environment,
  ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, AUTHORIZATION_CODE_TTL_SECONDS, RATE_LIMIT_PER_MINUTE,
};
