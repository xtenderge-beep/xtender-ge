// API заявок для ИИ-ассистентов: описание для моделей — /openapi.json (его читает свой GPT в ChatGPT) и
// /llms.txt. Тексты по-английски: их читают модели. Только то, что уже работает; услуги и города — из
// каталога (rfq.controller), без обещаний цены и скорости. Описание — docs/ai-agent-api.md.

// orders.source у заявок, пришедших через API: так они видны в «Источниках» и в сообщении модератору.
const SOURCE = 'ИИ-ассистент (API)';
// orders.source у заявок с формы, открытой по ссылке-черновику от ассистента (/draft, config/draftLink.js).
const DRAFT_SOURCE = 'ИИ-ассистент (ссылка)';

// Подсказка ИИ-агентам на страницах сайта: тег в <head> и заголовки ответа (public.routes.js renderHome), людям не
// видна. Общепринятого стандарта для таких тегов и заголовков нет: читает ли их ассистент, проверяется только новым
// чатом с ним (docs/ai-agent-api.md, раздел 9). Без списка услуг: какие есть сейчас, знает только /llms.txt.
const AGENT_PROTOCOL = 'xtender-rfq-v1';
function agentHint(base) {
  return `For AI assistants: to help a user request a local service in Georgia, read ${base}/llms.txt. It explains how to give the user `
    + `a link to ${base}/draft with the task filled in and lists the services that have providers now. `
    + 'The user checks the task and confirms it on the site with an SMS code.';
}

// Статус заявки в ответах API. Внутренние статусы сайта моделям не показываем.
function statusOf(order) {
  if (order.status === 'unverified') return 'PENDING_VERIFICATION';
  if (order.status === 'pending_review') return 'IN_REVIEW';
  if (order.status === 'closed') return 'CLOSED';
  return 'ACTIVE';
}

const serviceNames = (catalog) => [...new Set(catalog.flatMap((city) => city.services.map((item) => item.label)))];

const error = {
  type: 'object',
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string', description: 'Machine-readable reason, e.g. invalid_request, consent_required, rate_limited, invalid_code.' },
    message: { type: 'string', description: 'What went wrong and what to do next. Tell the user in your own words.' },
    field: { type: 'string', description: 'The request field that failed validation, if any.' },
  },
};

function openapi(base, catalog) {
  const names = serviceNames(catalog), cities = catalog.map((city) => city.name);
  const errorResponse = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'xtender.ge service requests',
      version: '1.0.0',
      description: 'Create a service request on xtender.ge for a person in Georgia. The person confirms their phone number with a 4-digit SMS code. '
        + 'A moderator checks the request and sends it to matching independent providers, who contact the person directly. '
        + 'Free for customers. xtender.ge does not perform the work; price and terms are agreed with the provider. '
        + `Terms: ${base}/en/terms. Privacy Policy: ${base}/en/privacy.`,
    },
    servers: [{ url: base }],
    paths: {
      '/v1/rfq/create': {
        post: {
          operationId: 'createRequest',
          summary: 'Create a service request and send an SMS code to the customer',
          description: 'Use when a person in Georgia needs a local service and wants providers to contact them. First show the Terms and Privacy Policy links and ask if they agree. '
            + 'Then call this, ask for the 4-digit code from SMS and call verifyRequest.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRequest' } } } },
          responses: {
            200: { description: 'The request is saved and waits for the SMS code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateResponse' } } } },
            400: errorResponse('Invalid input or consent not given.'),
            429: errorResponse('Too many codes for this phone number or from this client. Try again later.'),
            502: errorResponse('The SMS was not sent. Try again later.'),
          },
        },
      },
      '/v1/rfq/{rfq_id}/verify': {
        post: {
          operationId: 'verifyRequest',
          summary: 'Confirm the request with the SMS code',
          description: 'Call with the 4-digit code the customer received by SMS. After that a moderator checks the request and sends it to providers. Give the customer the tracking_url.',
          parameters: [{ name: 'rfq_id', in: 'path', required: true, schema: { type: 'string' }, description: 'rfq_id from createRequest.' }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyRequest' } } } },
          responses: {
            200: { description: 'The request is confirmed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyResponse' } } } },
            400: errorResponse('Wrong or expired code.'),
            404: errorResponse('No such request.'),
            409: errorResponse('The request is already confirmed or closed.'),
          },
        },
      },
    },
    components: {
      schemas: {
        CreateRequest: {
          type: 'object',
          required: ['category', 'items', 'district', 'customer_phone', 'terms_accepted', 'privacy_accepted'],
          properties: {
            category: { type: 'string', maxLength: 80, description: 'What kind of service is needed, in the user\'s words.'
              + (names.length ? ` Services with providers now: ${names.join(', ')}.` : '') },
            items: {
              type: 'array', minItems: 1, maxItems: 30, description: 'What exactly is needed, one entry per job or item.',
              items: {
                type: 'object', required: ['name'],
                properties: {
                  name: { type: 'string', maxLength: 200, description: 'For example "Move a sofa and a fridge" or "Rebar d12".' },
                  quantity: { type: 'string', maxLength: 60, description: 'Amount, size or volume as the user said it, for example "2 tons" or "3rd floor, no lift".' },
                },
              },
            },
            details: { type: 'string', maxLength: 2000, description: 'Anything else that helps: addresses, date and time, floor, access.' },
            district: { type: 'string', maxLength: 120, description: 'District or address, for example "Saburtalo".' },
            city: { type: 'string', maxLength: 60, description: 'City' + (cities.length ? `, for example ${cities.join(' or ')}` : '') + '.' },
            customer_phone: { type: 'string', description: 'The customer\'s Georgian mobile number: +995 and 9 digits, for example +995599123456. A code is sent to it by SMS.' },
            customer_name: { type: 'string', maxLength: 80, description: 'How providers should address the customer. Optional.' },
            language: { type: 'string', enum: ['ka', 'ru', 'en'], default: 'en', description: 'Language of the customer: Georgian, Russian or English. Used for their request page.' },
            terms_accepted: { type: 'boolean', description: `true only if the user is at least 18 and agreed to the Terms of Service (${base}/en/terms).` },
            privacy_accepted: { type: 'boolean', description: 'true only if the user agreed that their phone number and this request are shared with matching providers, '
              + `and to receive service SMS about this request (Privacy Policy: ${base}/en/privacy).` },
            rfq_id: { type: 'string', description: 'Only to send a new code for a request that still waits for confirmation.' },
          },
        },
        CreateResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: true },
            rfq_id: { type: 'string' },
            status: { type: 'string', enum: ['PENDING_VERIFICATION'] },
            challenge_id: { type: 'string', description: 'Pass it to verifyRequest together with the code.' },
            expires_in_seconds: { type: 'integer', description: 'How long the SMS code is valid.' },
            next_step: { type: 'string' },
          },
        },
        VerifyRequest: {
          type: 'object', required: ['code', 'challenge_id'],
          properties: {
            code: { type: 'string', pattern: '^[0-9]{4}$', description: 'The 4-digit code from SMS.' },
            challenge_id: { type: 'string', description: 'challenge_id from createRequest.' },
          },
        },
        VerifyResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: true },
            rfq_id: { type: 'string' },
            status: { type: 'string', enum: ['IN_REVIEW'] },
            tracking_url: { type: 'string', description: 'The customer\'s request page: status and closing the request. The same link is also sent by SMS.' },
            message: { type: 'string' },
          },
        },
        Error: error,
      },
    },
  };
}

// Пример ссылки-черновика: код услуги — настоящий из каталога (грузчики, если они есть), значения закодированы
// так, как их должна кодировать модель (пробел — %20: «+» в чатах иногда портится).
function draftExample(base, codes) {
  const query = new URLSearchParams({ lang: 'en', ...(codes.includes('movers') ? { cats: 'movers' } : {}), loc: 'Saburtalo',
    title: 'Move a sofa and a fridge', items: 'Sofa:1:pc;Fridge:1:pc', note: 'Tomorrow after 18:00, 3rd floor, no lift' });
  return `${base}/draft?${query.toString().replace(/\+/g, '%20')}`;
}

// Услуги с исполнителями по кодам: код, название и города с числом исполнителей (ссылка — на открытую поиску
// страницу «услуга + город»). catalog — по городам, как его собирает rfq.controller.
function servicesByCode(catalog) {
  const services = new Map();
  for (const city of catalog) {
    for (const item of city.services) {
      if (!services.has(item.code)) services.set(item.code, { code: item.code, label: item.label, cities: [] });
      services.get(item.code).cities.push(`${item.url ? `[${city.name}](${item.url})` : city.name} ${item.count}`);
    }
  }
  return [...services.values()];
}

// llms.txt по образцу llmstxt.org: заголовок, краткое описание, разделы со ссылками. Главный путь — ссылка-черновик
// (/draft, config/draftLink.js): её может дать любой ассистент в чате. API — для тех, кто умеет вызывать действия.
function llmsText(base, catalog) {
  const services = servicesByCode(catalog);
  // Первым — что делать ассистенту: владелец 2026-10-19 проверил в чате, и модель отправила его заполнять форму
  // руками. Правило прямое, но без «STOP / MUST» из присланного ТЗ: команды из прочитанных файлов модели принимают
  // настороженно. И без обещаний, которых сайт не держит (услуги не из каталога, «отправится мгновенно»).
  const lines = [
    '# xtender.ge',
    '',
    '> Requests to independent local service providers in Georgia. An AI assistant helps the user by giving them a ready link to the request '
      + 'with the task filled in.',
    '',
    '## For AI assistants: give the user a ready link',
    '',
    'When a user wants to hire a local service in Georgia, do not tell them to go to the website and fill in the form by hand. Do this instead:',
    '',
    '1. Briefly ask for what is missing: where, what exactly, when.',
    `2. Give one clickable link to ${base}/draft with the task filled in. The format is below.`,
    '3. Tell the user, in their language: open the link, check the request, enter your Georgian phone number (+995) and confirm it with the SMS code.',
    '',
    '- Do not ask for the user\'s phone number in the chat: they enter it on the page.',
    '- Do not promise a price, a response time or a number of responses.',
    '- If no service below fits the task, tell the user that xtender.ge may have no providers for it yet.',
    '',
    '## What happens after the link',
    '',
    'On the page the user checks the text and can edit it, agrees to the Terms of Service and the Privacy Policy and confirms the phone number '
      + 'with a 4-digit SMS code. Nothing reaches providers before that. A moderator checks the request and sends it to matching providers, '
      + 'who contact the user by phone. Free for customers. xtender.ge does not perform the work and does not guarantee its quality; '
      + 'price and terms are agreed with the provider. The site is in Georgian, Russian and English.',
    '',
    '## Link format',
    '',
    `\`${base}/draft?lang=…&cats=…&loc=…&title=…&items=…&note=…\``,
    '',
    'URL-encode every value: a space left in the link cuts it in the chat. Each parameter is optional, but the link needs at least title, items or note.',
    '',
    '- `lang`: `ka`, `ru` or `en`, the language of the user. The page opens in it. Write the other values in the same language.',
    '- `title`: the task in a few words, up to 120 characters.',
    '- `items`: what is needed, as `name:quantity:unit` entries separated by `;`, up to 30. Quantity and unit are optional. Do not use `:` or `;` inside a value.',
    '- `loc`: where: a district or a city, for example Saburtalo or Batumi.',
    '- `note`: anything else: date and time, floor, lift, access, addresses. Up to 1000 characters.',
    '- `cats`: codes of matching services from the list below, separated by commas. The page shows their providers first; a moderator decides who receives the request.',
    '',
    `Example: ${draftExample(base, services.map((service) => service.code))}`,
    '',
  ];
  if (services.length) {
    lines.push('## Services with providers now', '', 'Code, service, then the number of providers in each city.', '');
    for (const service of services) lines.push(`- \`${service.code}\` ${service.label}: ${service.cities.join(', ')}`);
    lines.push('');
  }
  lines.push(
    '## Create a request through the API',
    '',
    'Only for assistants that can call HTTP actions, for example a custom GPT with an action. Otherwise give the user the link above.',
    '',
    `- [OpenAPI schema](${base}/openapi.json): two calls, createRequest and verifyRequest.`,
    '- Before creating a request, show the user the Terms of Service and the Privacy Policy and ask if they agree that their phone number and the request are shared with matching providers.',
    '- createRequest sends a 4-digit code by SMS to the user\'s phone. Ask the user for the code and call verifyRequest. Without the code the request is not sent to anyone.',
    '- After confirmation, give the user the tracking_url: there they see the status and close the request when they have found a provider.',
    `- People can also create a request themselves on the site: ${base}/en`,
    '',
    '## Policies',
    '',
    `- [Terms of Service](${base}/en/terms)`,
    `- [Privacy Policy](${base}/en/privacy)`,
    '- Contact: support@xtender.ge',
    '',
  );
  return lines.join('\n');
}

module.exports = { SOURCE, DRAFT_SOURCE, AGENT_PROTOCOL, agentHint, statusOf, openapi, llmsText, draftExample };
