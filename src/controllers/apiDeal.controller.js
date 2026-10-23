// Обработчики API v1 для сделки: заявки, предложения, выбор, переписка, уведомления (docs/api-v1/WORKFLOWS.md).
// Правила — в src/services/dealApi.service.js (тот же слой вызывает MCP-адаптер); здесь — HTTP: версии (If-Match/ETag),
// пагинация, коды ответов. Аккаунт берётся из токена: чужой id в запросе ничего не даёт (тот же 404, что и для
// несуществующего объекта).
const api = require('../middleware/apiV1');
const dealApi = require('../services/dealApi.service');
const catalog = require('../services/apiCatalog.service');
const { requestMeta } = require('../config/requestMeta');
const { langOf, paginate, pageParams } = require('./apiV1.controller');

const { send, fail } = api;

// Канал заявки: ChatGPT или другой клиент API — по имени подключённого приложения.
function channelOf(auth) {
  return /chatgpt|openai/i.test(auth?.grant?.client_name || '') ? 'chatgpt' : 'api';
}

async function ctx(req) {
  return dealApi.context(req.auth.account, { lang: langOf(req), meta: requestMeta(req), channel: channelOf(req.auth) });
}

function body(req) {
  if (req.body === undefined || req.body === null) return {};
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw fail(400, 'INVALID_REQUEST', 'Send a JSON object.');
  return req.body;
}

function date(req, name) {
  const raw = req.query[name];
  if (raw === undefined) return null;
  const at = Date.parse(String(raw));
  if (Number.isNaN(at)) throw fail(422, 'VALIDATION_FAILED', `${name}: RFC 3339 date-time.`, { fields: [{ path: name, code: 'INVALID_DATE' }] });
  return new Date(at);
}

function listResponse(req, res, items, filters) {
  const version = 'lst_' + catalog.hash(items.map((item) => [item.id, item.version, item.status]));
  const page = paginate(items, pageParams(req), { version, filters });
  return send(req, res, 200, { items: page.page, next_cursor: page.next_cursor, has_more: page.has_more });
}

function withVersion(res, object) {
  api.setVersion(res, object.version);
  return object;
}

// --- Заявки ---------------------------------------------------------------------------------------------------------
async function createTender(req, res) {
  const tender = await dealApi.createTender(await ctx(req), body(req));
  return send(req, res, 201, withVersion(res, tender));
}

async function getTender(req, res) {
  return send(req, res, 200, withVersion(res, await dealApi.getTender(await ctx(req), req.params.id)));
}

async function updateTender(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.updateTender(await ctx(req), req.params.id, expected, body(req))));
}

async function validateTender(req, res) {
  return send(req, res, 200, await dealApi.validateTender(await ctx(req), req.params.id));
}

async function publishTender(req, res) {
  const expected = api.expectedVersion(req);
  const result = await dealApi.publishTender(await ctx(req), req.params.id, expected, { confirmed: body(req).confirmation?.confirmed_by_user });
  api.setVersion(res, result.tender.version);
  return send(req, res, 202, result);
}

async function listMyTenders(req, res) {
  const status = req.query.status;
  if (status !== undefined && !['draft', 'open', 'closed', 'selection_pending', 'awarded', 'completed', 'cancelled'].includes(status)) {
    throw fail(422, 'VALIDATION_FAILED', 'Unknown status.', { fields: [{ path: 'status', code: 'INVALID_OPTION' }] });
  }
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined;
  const updatedSince = date(req, 'updated_since');
  const items = await dealApi.listMyTenders(await ctx(req), { status, q, updatedSince });
  return listResponse(req, res, items, { route: 'me/tenders', status, q, updatedSince });
}

async function resolveTender(req, res) {
  if (typeof req.query.number !== 'string' || !req.query.number.trim()) throw fail(422, 'VALIDATION_FAILED', 'number is required.', { fields: [{ path: 'number', code: 'REQUIRED' }] });
  return send(req, res, 200, await dealApi.resolveTender(await ctx(req), req.query.number));
}

async function tenderStatus(req, res) {
  return send(req, res, 200, await dealApi.tenderStatus(await ctx(req), req.params.id));
}

async function closeTender(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.closeTender(await ctx(req), req.params.id, expected)));
}

async function cancelTender(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.cancelTender(await ctx(req), req.params.id, expected, body(req).reason)));
}

async function completeTender(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.completeTender(await ctx(req), req.params.id, expected)));
}

async function setResponseMode(req, res) {
  const expected = api.expectedVersion(req);
  const input = body(req);
  return send(req, res, 200, withVersion(res, await dealApi.setResponseMode(await ctx(req), req.params.id, expected,
    { mode: input.response_mode, confirmed: input.confirmed_by_user })));
}

async function tenderOffers(req, res) {
  const status = req.query.status;
  const result = await dealApi.tenderOffers(await ctx(req), req.params.id, { status });
  return listResponse(req, res, result.items, { route: 'tender/offers', id: req.params.id, status });
}

async function comparison(req, res) {
  const data = await dealApi.comparison(await ctx(req), req.params.id);
  if (req.query.snapshot_id !== undefined && req.query.snapshot_id !== data.snapshot_id) {
    throw fail(409, 'SNAPSHOT_CHANGED', 'Offers changed since this snapshot. Read the comparison again from the first page.', { details: { current_snapshot_id: data.snapshot_id } });
  }
  const page = paginate(data.offers, pageParams(req), { version: data.snapshot_id, filters: { route: 'comparison', id: req.params.id } });
  return send(req, res, 200, { ...data, offers: page.page, next_cursor: page.next_cursor, has_more: page.has_more });
}

async function selectOffer(req, res) {
  const input = body(req);
  const selection = await dealApi.selectOffer(await ctx(req), req.params.id, { offerId: input.offer_id, offerVersion: input.expected_offer_version,
    tenderVersion: input.expected_tender_version, confirmed: input.confirmed_by_user });
  return send(req, res, 201, selection);
}

// --- Исполнитель и предложения --------------------------------------------------------------------------------------
async function opportunities(req, res) {
  const filters = { categoryId: typeof req.query.category_id === 'string' ? req.query.category_id : undefined,
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined, startFrom: date(req, 'requested_start_from'), startTo: date(req, 'requested_start_to') };
  const items = await dealApi.opportunities(await ctx(req), filters);
  return listResponse(req, res, items, { route: 'opportunities', ...filters });
}

async function createOffer(req, res) {
  return send(req, res, 201, withVersion(res, await dealApi.createOffer(await ctx(req), req.params.id, body(req))));
}

async function getOffer(req, res) {
  return send(req, res, 200, withVersion(res, await dealApi.getOffer(await ctx(req), req.params.id)));
}

async function updateOffer(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.updateOffer(await ctx(req), req.params.id, expected, body(req))));
}

async function submitOffer(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.submitOffer(await ctx(req), req.params.id, expected)));
}

async function withdrawOffer(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.withdrawOffer(await ctx(req), req.params.id, expected)));
}

async function myOffers(req, res) {
  const filters = { tenderId: typeof req.query.tender_id === 'string' ? req.query.tender_id : undefined, status: typeof req.query.status === 'string' ? req.query.status : undefined };
  const items = await dealApi.myOffers(await ctx(req), filters);
  return listResponse(req, res, items, { route: 'me/offers', ...filters });
}

async function acceptSelection(req, res) {
  return send(req, res, 200, await dealApi.acceptSelection(await ctx(req), req.params.id));
}

async function declineSelection(req, res) {
  return send(req, res, 200, await dealApi.declineSelection(await ctx(req), req.params.id, body(req).reason));
}

// --- Переписка ------------------------------------------------------------------------------------------------------
async function createThread(req, res) {
  return send(req, res, 201, await dealApi.createThread(await ctx(req), req.params.id, body(req).text));
}

async function listThreads(req, res) {
  const items = await dealApi.listThreads(await ctx(req), req.params.id);
  return listResponse(req, res, items.map((t) => ({ ...t, version: t.last_message_at })), { route: 'threads', id: req.params.id });
}

async function listMessages(req, res) {
  const items = await dealApi.messages(await ctx(req), req.params.id);
  return listResponse(req, res, items, { route: 'messages', id: req.params.id });
}

async function sendMessage(req, res) {
  const input = body(req);
  if (input.attachment_ids !== undefined && (!Array.isArray(input.attachment_ids) || input.attachment_ids.length)) {
    throw fail(422, 'ATTACHMENTS_NOT_SUPPORTED', 'Attachments are not available yet.', { fields: [{ path: 'attachment_ids', code: 'NOT_SUPPORTED' }] });
  }
  return send(req, res, 201, await dealApi.sendMessage(await ctx(req), req.params.id, input.text));
}

// --- Уведомления ----------------------------------------------------------------------------------------------------
async function notificationPreferences(req, res) {
  return send(req, res, 200, withVersion(res, await dealApi.notificationPreferences(await ctx(req))));
}

async function updateNotificationPreferences(req, res) {
  const expected = api.expectedVersion(req);
  return send(req, res, 200, withVersion(res, await dealApi.updateNotificationPreferences(await ctx(req), expected, body(req))));
}

async function subscribeTender(req, res) {
  return send(req, res, 200, await dealApi.subscribeTender(await ctx(req), req.params.id, body(req)));
}

async function unsubscribeTender(req, res) {
  const result = await dealApi.unsubscribeTender(await ctx(req), req.params.id);
  return send(req, res, 200, { ...result, deleted: true });
}

async function notifications(req, res) {
  const items = await dealApi.notifications(await ctx(req));
  return listResponse(req, res, items.map((n) => ({ ...n, version: n.status })), { route: 'notifications' });
}

async function resumeLink(req, res) {
  return send(req, res, 201, await dealApi.resumeLink(await ctx(req), req.params.id));
}

module.exports = {
  createTender, getTender, updateTender, validateTender, publishTender, listMyTenders, resolveTender, tenderStatus, closeTender, cancelTender,
  completeTender, setResponseMode, tenderOffers, comparison, selectOffer, opportunities, createOffer, getOffer, updateOffer, submitOffer,
  withdrawOffer, myOffers, acceptSelection, declineSelection, createThread, listThreads, listMessages, sendMessage, notificationPreferences,
  updateNotificationPreferences, subscribeTender, unsubscribeTender, notifications, resumeLink, channelOf,
};
