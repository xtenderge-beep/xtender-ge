// MCP-сервер для ИИ-ассистентов (плагин ChatGPT, коннектор Claude): POST /mcp. Два инструмента, оба только читают:
// list_services — услуги с исполнителями по городам; create_request_link — ссылка /draft с готовой заявкой. Заявку
// человек подтверждает сам, на сайте, кодом из SMS: сервер ничего не записывает и номер телефона не спрашивает.
// Без состояния: на каждый запрос свой сервер и транспорт, ответ — JSON, без потока. Описание — docs/ai-agent-api.md,
// раздел 10.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const assistantCatalog = require('../services/assistantCatalog.service');
const agentApi = require('../config/agentApi');
const draftLink = require('../config/draftLink');
const { getBaseUrl } = require('../config/url');
const { version } = require('../../package.json');

// Длиннее ссылку не все чаты и браузеры донесут целиком; столько не набрать и в пределах полей (draftLink.LIMITS).
const MAX_LINK_LENGTH = 6000;

// Тот же порядок, что в начале /llms.txt (agentApi.llmsText): уточнить, дать ссылку полным адресом, зачем так и что дальше.
const INSTRUCTIONS = 'xtender.ge connects customers in Georgia with independent local service providers. '
  + 'To help a user hire a local service in Georgia: ask briefly for what is missing (where, what exactly, when), call '
  + 'create_request_link and give the user the link as the full address on its own line. ' + agentApi.WHY + ' '
  + 'The user enters a Georgian phone number (+995) on the page; do not ask for it in the chat. ' + agentApi.AFTER + ' '
  + 'list_services shows the cities with providers; for any other place, tell the user that xtender.ge may have no providers there yet. '
  + 'Do not promise a price, a response time or a number of responses.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Двоеточие и точка с запятой разделяют поля позиции в ссылке (draftLink.parseItems): внутри значения их не оставляем.
const field = (value) => String(value ?? '').replace(/[:;]+/g, ' ').replace(/\s+/g, ' ').trim();

// Коды услуг, у которых есть исполнители хотя бы в одном городе.
function liveCodes(catalog) {
  return new Map(catalog.flatMap((city) => city.services.map((service) => [service.code, service])));
}

async function listServices() {
  const catalog = await assistantCatalog.getOrEmpty();
  if (!catalog.length) {
    return { content: [{ type: 'text', text: 'No services have providers right now. Tell the user that xtender.ge may have no providers for this task yet.' }] };
  }
  const lines = [];
  for (const [code, service] of liveCodes(catalog)) {
    const cities = catalog.filter((city) => city.services.some((item) => item.code === code))
      .map((city) => `${city.name} ${city.services.find((item) => item.code === code).count}`);
    lines.push(`- ${code}: ${service.names.en} / ${service.names.ru} / ${service.names.ka} — providers: ${cities.join(', ')}`);
  }
  return {
    content: [{ type: 'text', text: 'Services with providers now (code: names in English / Russian / Georgian — providers per city):\n'
      + lines.join('\n') + '\nPass the matching codes as services to create_request_link.' }],
    structuredContent: { cities: catalog.map((city) => ({ name: city.name, slug: city.slug, names: city.names,
      services: city.services.map(({ code, names, count, url }) => ({ code, names, providers: count, url })) })) },
  };
}

async function createRequestLink(input) {
  const items = (input.items || []).map((item) => [field(item.name), field(item.quantity), field(item.unit)])
    .filter(([name]) => name).map((parts) => parts.join(':').replace(/:+$/, ''));
  const query = { lang: input.lang };
  // Только услуги с исполнителями: остальные страница всё равно отбросит, а ассистент должен об этом знать.
  const live = liveCodes(await assistantCatalog.getOrEmpty());
  const wanted = [...new Set((input.services || []).map((code) => String(code).trim().toLowerCase()).filter(Boolean))];
  const services = wanted.filter((code) => live.has(code)), dropped = wanted.filter((code) => !live.has(code));
  if (services.length) query.cats = services.join(',');
  if (input.location) query.loc = input.location;
  if (input.title) query.title = input.title;
  if (items.length) query.items = items.join(';');
  if (input.note) query.note = input.note;
  const draft = draftLink.parse(query);
  if (!draft) return { isError: true, content: [{ type: 'text', text: 'The request is empty: give at least a title, items or a note.' }] };

  const url = `${getBaseUrl()}/draft?${new URLSearchParams(query).toString().replace(/\+/g, '%20')}`;
  if (url.length > MAX_LINK_LENGTH) {
    return { isError: true, content: [{ type: 'text', text: 'The request is too long for a link. Shorten the note or the item names and call again.' }] };
  }
  const preview = draftLink.text(draft, draft.lang);
  const warnings = [
    ...dropped.map((code) => `Service code "${code}" has no providers now and was left out; see list_services.`),
    ...(wanted.length && !services.length ? ['None of the chosen services has providers now: tell the user that xtender.ge may have no providers for this task yet.'] : []),
  ];
  return {
    content: [{ type: 'text', text: [
      'Give the user this link as the full address on its own line:', url, '',
      'The request will read:', preview, '',
      'Tell the user, in their language: open the link, check the request, enter your Georgian phone number (+995) and confirm it with the SMS code.',
      ...(warnings.length ? ['', ...warnings] : []),
    ].join('\n') }],
    structuredContent: { url, preview, services, warnings },
  };
}

function buildServer() {
  const server = new McpServer({ name: 'xtender', title: 'xtender.ge', version }, { instructions: INSTRUCTIONS });
  server.registerTool('list_services', {
    title: 'Services with providers',
    description: 'Lists the services on xtender.ge (Georgia) that have providers now, by city, with service codes and provider counts. Use the codes in create_request_link.',
    annotations: { title: 'Services with providers', ...READ_ONLY },
  }, listServices);
  server.registerTool('create_request_link', {
    title: 'Create a request link',
    description: 'Builds a link to xtender.ge with the user\'s request filled in. Nothing is sent: the user opens the link, checks the request '
      + 'and confirms it with their phone number and an SMS code. Give the link to the user as the full address on its own line.',
    inputSchema: {
      lang: z.enum(['ka', 'ru', 'en']).describe('The user\'s language: Georgian, Russian or English. The page opens in it; write the other fields in it too.'),
      title: z.string().max(draftLink.LIMITS.title).optional().describe('The task in a few words.'),
      items: z.array(z.object({
        name: z.string().min(1).max(draftLink.LIMITS.name).describe('What is needed, for example "Sofa" or "Movers".'),
        quantity: z.union([z.string().max(20), z.number()]).optional().describe('How many, for example 2.'),
        unit: z.string().max(20).optional().describe('Unit, for example "pcs", "people", "m3".'),
      })).max(draftLink.LIMITS.items).optional().describe('What exactly is needed, one entry per thing.'),
      location: z.string().max(draftLink.LIMITS.loc).optional().describe('District or city, for example Saburtalo or Batumi.'),
      note: z.string().max(draftLink.LIMITS.note).optional().describe('Anything else: date and time, floor, lift, access, addresses.'),
      services: z.array(z.string().max(32)).max(draftLink.LIMITS.cats).optional().describe('Codes of matching services from list_services.'),
    },
    annotations: { title: 'Create a request link', ...READ_ONLY },
  }, createRequestLink);
  return server;
}

async function handle(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Сервер без состояния: потока событий (GET) и закрытия сессии (DELETE) нет.
function notAllowed(req, res) {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: use POST.' }, id: null });
}

module.exports = { handle, notAllowed, INSTRUCTIONS };
