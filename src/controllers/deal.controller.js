// Сделка на страницах сайта (docs/api-v1/WORKFLOWS.md): блоки на странице заявки исполнителя (/order/<token>) и заказчика
// (/o/<owner_token>), действия /api/orders/<token>/deal/<действие>, согласие /consent/<токен> и страница возврата из SMS
// /t/<токен>. Сайт работает целиком без ChatGPT: те же сервисы, что у API.
// Кто пишет: заказчик — по куке владельца заявки (как закрытие заявки); исполнитель — только вошедший в кабинет
// (master_session). Личная ссылка из SMS открывает чтение, но писать от имени исполнителя по ней нельзя: пересланная
// ссылка не даёт отправить предложение или подтвердить заказ за другого.
const pool = require('../config/db');
const deal = require('../config/deal');
const dealCopy = require('../config/deal-copy');
const tenders = require('../services/tender.service');
const offers = require('../services/offer.service');
const selections = require('../services/selection.service');
const threads = require('../services/thread.service');
const notify = require('../services/dealNotify.service');
const access = require('../services/orderAccess.service');
const masterSession = require('../services/masterSession.service');
const { requestMeta } = require('../config/requestMeta');
const { toE164 } = require('../config/phone');

const { DealError } = deal;
const DEAL_MODES = ['offers', 'both'];
const isDealOrder = (order) => Boolean(order) && (DEAL_MODES.includes(order.response_mode) || Boolean(order.deal_status));

// --- Данные для страницы ---------------------------------------------------------------------------------------------
async function providerName(masterId) {
  return (await offers.providerInfo(masterId)).display_name;
}

async function threadWithMessages(thread, role) {
  const view = await threads.threadView(thread, role);
  view.messages = (await threads.messages(thread, { markSeenBy: role })).map(threads.messageView);
  return view;
}

function common(order, lang) {
  const c = dealCopy.copy(lang);
  const at = (value) => (value ? deal.formatLocal(value, lang, order.timezone || 'Asia/Tbilisi') : '');
  return { c, at, status: tenders.status(order), publication: tenders.publication(order), mode: order.response_mode, version: order.api_version,
    acceptsOffers: tenders.acceptsOffers(order), acceptsMessages: tenders.acceptsMessages(order), deadline: at(order.submission_deadline) };
}

async function ownerLocals(order, lang) {
  const base = common(order, lang);
  const list = await offers.listForOrder(order.id, { includeInactive: true });
  const shown = list.filter((o) => o.status !== 'draft');
  const offerViews = await Promise.all(shown.map((o) => offers.view(o, { withVersions: true })));
  const threadRows = await threads.listForOrder(order.id);
  const threadViews = await Promise.all(threadRows.map((t) => threadWithMessages(t, 'customer')));
  const selection = await selections.latest(order.id);
  let selectionView = null;
  if (selection) {
    selectionView = { ...selections.view(selection), providerName: await providerName(selection.master_id), confirmBy: base.at(selection.confirm_by) };
    if (selection.status === 'accepted') selectionView.providerPhone = (await pool.query('SELECT phone FROM masters WHERE id=$1', [selection.master_id])).rows[0]?.phone || null;
  }
  const settings = await notify.settings(order.id);
  const account = order.account_id ? await require('../services/account.service').getById(order.account_id) : null;
  return {
    ...base, role: 'owner', offers: offerViews, threads: threadViews, selection: selectionView,
    canClose: base.status === 'open' && base.publication === 'published' && !order.collection_closed_at,
    canSelect: ['open', 'closed'].includes(base.status) && base.publication === 'published',
    canCancel: ['open', 'closed', 'selection_pending'].includes(base.status) && order.status !== 'closed',
    canComplete: base.status === 'awarded', canAllowCalls: base.mode === 'offers' && order.status !== 'closed',
    notify: { smsEnabled: settings.sms_enabled, rules: settings.rules, consentGiven: Boolean(settings.consent_log_id || account?.notify_consent_log_id) },
    chatPrompt: require('../services/resumeLink.service').chatPrompt(order, lang),
  };
}

async function providerLocals(order, master, { canWrite, lang }) {
  const base = common(order, lang);
  const units = require('../config/units');
  const unitLabel = (code) => { const unit = code && units.UNITS.find((u) => u.code === code); return unit ? units.view(unit, lang).short : code || null; };
  const items = (await tenders.items(order.id)).map((item) => ({ ...item, unitLabel: unitLabel(item.unit) }));
  const own = await offers.mine(order.id, master.id);
  const ownView = own && own.status !== 'draft' ? await offers.view(own, { withVersions: true }) : null;
  const thread = await pool.withTransaction((client) => threads.forProvider(client, order, master)).catch(() => null);
  const selection = await selections.latest(order.id);
  const mySelection = selection && selection.master_id === master.id ? { ...selections.view(selection), confirmBy: base.at(selection.confirm_by) } : null;
  const confirmed = mySelection?.status === 'accepted';
  const need = offers.needs(order, items);
  return {
    ...base, role: 'provider', canWrite, offer: ownView, draft: own && own.status === 'draft' ? own.data : null, items, need,
    thread: thread ? await threadWithMessages(thread, 'provider') : null, selection: mySelection, confirmed,
    customerPhone: confirmed ? toE164(order.phone) : null, privateAddress: confirmed ? order.private_address || null : null,
    // Звонок и WhatsApp: в режиме «сначала предложения» — только после подтверждённого выбора.
    contactOpen: base.mode !== 'offers' || confirmed,
    canEditOffer: canWrite && base.acceptsOffers && (!ownView || ['submitted', 'withdrawn', 'expired'].includes(ownView.status)),
    loginHref: '/master?next=' + encodeURIComponent('/order/' + order.token),
  };
}

// Для order.controller: null — страница заявки как раньше (звонки, старые заявки).
async function pageLocals(order, { isOwner, master, sessionMaster, lang }) {
  if (!isDealOrder(order) || order.status === 'unverified') return null;
  if (isOwner) return ownerLocals(order, lang);
  if (!master || master.is_banned || !(await access.has(order.id, master.id))) return null;
  return providerLocals(order, master, { canWrite: Boolean(sessionMaster) && sessionMaster.id === master.id, lang });
}

// --- Действия --------------------------------------------------------------------------------------------------------
const OWNER_ACTIONS = ['reply', 'select', 'close-collection', 'cancel', 'complete', 'allow-calls', 'notifications'];
const PROVIDER_ACTIONS = ['offer', 'withdraw', 'message', 'accept', 'decline'];

function ownerCookie(req, order) {
  return Boolean(order?.owner_token) && req.cookies?.[`order_${order.token}`] === order.owner_token;
}

// Тетри из поля «₾»; пустое — неизвестно (null), а не ноль.
function gel(value, path, fields) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const minor = deal.gelToMinor(value);
  if (!Number.isFinite(minor)) { fields.push({ path, code: 'INVALID_MONEY' }); return null; }
  return minor;
}

// Поле datetime-local без пояса — время Тбилиси (+04:00, без перехода на летнее время).
function localTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) ? text + ':00+04:00' : /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T23:59:00+04:00' : text;
}

const lines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, deal.LIMITS.list);

// Форма сайта → OfferInput API (offer.service проверит всё ещё раз).
async function offerInput(order, body, c) {
  const fields = [];
  const items = await tenders.items(order.id);
  const need = offers.needs(order, items);
  const lineItems = [];
  for (const item of items.filter((i) => i.kind === 'goods' || i.kind === 'service')) {
    const price = gel(body[`item_${item.id}_price`], `items.${item.id}`, fields);
    const substitution = body[`item_${item.id}_sub`] === true || body[`item_${item.id}_sub`] === 'on';
    lineItems.push({ tender_item_id: item.id, offered_name: item.name, quantity: item.quantity, unit: item.unit, unit_price_minor: price,
      is_substitution: substitution, deviation_description: substitution ? String(body[`item_${item.id}_note`] || '').trim() || null : null });
  }
  // Строка «работа»: всегда, если позиций нет; при позициях — если исполнитель её заполнил (работа сверх товаров).
  if (!lineItems.length || String(body.work_price || '').trim() || String(body.work_name || '').trim()) {
    lineItems.push({ offered_name: String(body.work_name || '').trim() || c('f_work_default'), line_total_minor: gel(body.work_price, 'work_price', fields) });
  }
  const charge = (key) => {
    if (!need[key]) return undefined;
    const state = body[`${key}_state`] || 'unknown';
    return { state, amount_minor: state === 'separate' ? gel(body[`${key}_amount`], `${key}_amount`, fields) : null };
  };
  const extra = String(body.extra_name || '').trim()
    ? [{ name: String(body.extra_name).trim(), amount_minor: gel(body.extra_amount, 'extra_amount', fields) }] : [];
  const deposit = String(body.deposit_percent || '').trim();
  const input = {
    pricing_type: body.pricing_type || 'fixed', line_items: lineItems, additional_costs: extra,
    ...(charge('delivery') ? { delivery: charge('delivery') } : {}), ...(charge('unloading') ? { unloading: charge('unloading') } : {}),
    start_at: localTime(body.start_at), completion_at: localTime(body.completion_at), valid_until: localTime(body.valid_until),
    payment_terms: { text: String(body.payment_text || '').trim() || null, deposit_percent: deposit === '' ? null : Number(deposit) },
    warranty: String(body.warranty || '').trim() || null, notes: String(body.notes || '').trim() || null,
    exclusions: lines(body.exclusions), assumptions: lines(body.assumptions),
  };
  if (fields.length) throw new DealError(422, 'VALIDATION_FAILED', 'Some offer fields are invalid.', { fields });
  return input;
}

function errorMessage(error, c) {
  const byCode = {
    VERSION_MISMATCH: 'err_version', COLLECTION_CLOSED: 'err_closed', VALIDATION_FAILED: 'err_fields', SELECTION_EXISTS: 'err_selection_exists',
    OFFER_NOT_AVAILABLE: 'err_offer_unavailable', OFFER_EXPIRED: 'err_offer_unavailable', CONSENT_REQUIRED: 'err_consent', OWN_REQUEST: 'err_own_request',
    IN_REVIEW: 'err_in_review', OFFERS_NOT_ACCEPTED: 'err_closed',
  };
  if (error.code === 'ACTION_NOT_ALLOWED' && error.details?.support_url) return c('err_support');
  if (error.code === 'VALIDATION_FAILED' && (error.fields || []).some((f) => f.path === 'reason')) return c('err_reason');
  return c(byCode[error.code] || 'error_generic');
}

async function action(req, res) {
  masterSession.noStore(res);
  const lang = ['ka', 'ru', 'en'].includes(req.body?.lang) ? req.body.lang : req.lang;
  const c = dealCopy.copy(lang);
  const name = String(req.params.action || '');
  // Только JSON: обычная форма с чужого сайта сюда не дойдёт с данными (вместе с SameSite=Lax у кук входа).
  if (!req.is('application/json')) return res.status(415).json({ success: false, message: c('error_generic') });
  const order = (await pool.query('SELECT * FROM orders WHERE token=$1', [req.params.token])).rows[0];
  if (!order || !isDealOrder(order)) return res.status(404).json({ success: false, message: c('error_generic') });
  const body = req.body || {};
  const meta = requestMeta(req);
  try {
    if (OWNER_ACTIONS.includes(name)) {
      if (!ownerCookie(req, order)) return res.status(403).json({ success: false, message: c('error_generic') });
      const expected = body.version === undefined ? null : Number(body.version);
      if (name === 'reply') {
        const { thread } = await threads.forViewer({ ownerOrderId: order.id }, body.thread_id);
        await threads.send(order, thread, 'customer', body.text);
      } else if (name === 'select') {
        await selections.select(order.id, { offerId: String(body.offer_id || ''), offerVersion: Number(body.offer_version), tenderVersion: Number(body.tender_version), actor: 'customer', meta });
      } else if (name === 'close-collection') {
        await tenders.closeCollection(order.id, { actor: 'customer', expected });
      } else if (name === 'cancel') {
        await tenders.cancel(order.id, { reason: body.reason, expected, actor: 'client', meta });
      } else if (name === 'complete') {
        await tenders.complete(order.id, { expected, actor: 'client', meta });
      } else if (name === 'allow-calls') {
        await tenders.setResponseMode(order.id, 'both', { expected });
      } else if (name === 'notifications') {
        const rules = Object.fromEntries(notify.RULES.map((rule) => [rule, body.rules?.[rule] === true]));
        const account = order.account_id ? await require('../services/account.service').getById(order.account_id) : null;
        await notify.setSettings(order, { smsEnabled: body.sms === true, rules, language: lang, source: 'site', meta, consentAccepted: body.consent === true,
          accountConsentLogId: account?.notify_consent_log_id || null });
      }
    } else if (PROVIDER_ACTIONS.includes(name)) {
      const token = await masterSession.token(req);
      const master = token ? (await pool.query('SELECT * FROM masters WHERE master_token=$1', [token])).rows[0] : null;
      if (!master || master.is_banned) return res.status(401).json({ success: false, code: 'login', message: c('err_login') });
      if (name === 'offer') {
        await offers.saveAndSubmit(master, order, await offerInput(order, body, c));
      } else if (name === 'withdraw') {
        const own = await offers.mine(order.id, master.id);
        if (!own) throw tenders.notFound();
        await offers.withdraw(master, own.id, body.version === undefined ? own.version : Number(body.version));
      } else if (name === 'message') {
        const thread = await pool.withTransaction((client) => threads.forProvider(client, order, master));
        await threads.send(order, thread, 'provider', body.text, { master });
      } else if (name === 'accept' || name === 'decline') {
        const own = await offers.mine(order.id, master.id);
        if (!own) throw tenders.notFound();
        if (name === 'accept') await selections.accept(master, own.id, { meta });
        else await selections.decline(master, own.id, body.reason);
      }
    } else {
      return res.status(404).json({ success: false, message: c('error_generic') });
    }
    require('../services/dealApi.service').kick();
    return res.json({ success: true });
  } catch (error) {
    if (!(error instanceof DealError)) throw error;
    return res.status(error.status).json({ success: false, code: error.code, fields: error.fields || [], message: errorMessage(error, c) });
  }
}

// --- Согласие перед первой публикацией из ChatGPT: /consent/<токен> ------------------------------------------------
const PAGE_LANGS = ['ka', 'ru', 'en'];

function pageLang(req, fallback) {
  const asked = req.query?.lang || req.body?.lang;
  return PAGE_LANGS.includes(asked) ? asked : PAGE_LANGS.includes(fallback) ? fallback : req.lang;
}

function renderPage(res, status, view, lang, locals = {}) {
  masterSession.noStore(res);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return res.status(status).render('deal-page', { view, lang, c: dealCopy.copy(lang), ...locals });
}

async function consentPage(req, res) {
  const link = await require('../services/accountConsent.service').readLink(req.params.token);
  const account = link ? await require('../services/account.service').getById(link.accountId) : null;
  const lang = pageLang(req, account?.locale);
  if (!link || !account) return renderPage(res, 404, 'expired', lang, { message: dealCopy.copy(lang)('consent_expired') });
  const consent = await require('../services/consent.service').bundle('client', lang);
  return renderPage(res, 200, 'consent', lang, { consent, token: req.params.token, langHref: `/consent/${req.params.token}?lang=` });
}

async function consentSubmit(req, res) {
  const accountConsent = require('../services/accountConsent.service');
  const link = await accountConsent.readLink(req.params.token);
  const account = link ? await require('../services/account.service').getById(link.accountId) : null;
  const lang = pageLang(req, account?.locale);
  const c = dealCopy.copy(lang);
  if (!link || !account) return renderPage(res, 404, 'expired', lang, { message: c('consent_expired') });
  const consent = await require('../services/consent.service').bundle('client', lang);
  const again = (status, error) => renderPage(res, status, 'consent', lang, { consent, token: req.params.token, error, langHref: `/consent/${req.params.token}?lang=` });
  if (req.body?.terms !== '1' || req.body?.privacy !== '1') return again(400, c('consent_required'));
  // Человек принял именно показанный текст: если тексты сменились, пока страница была открыта, — показать новые.
  if (req.body?.digest !== consent.digest) return again(409, c('err_version'));
  const accepted = await accountConsent.accept(req.params.token, { bundle: consent, sms: req.body?.sms === '1', meta: requestMeta(req) });
  if (!accepted) return renderPage(res, 404, 'expired', lang, { message: c('consent_expired') });
  return renderPage(res, 200, 'consent_done', lang);
}

// --- Возврат по ссылке из SMS: /t/<токен> -----------------------------------------------------------------------------
// Пересланная ссылка не открывает ни предложений, ни контактов, ни переписки: только номер и состояние заявки, команду
// для ChatGPT и повтор ссылки на страницу заявки SMS-сообщением на номер самой заявки.
async function resumeView(order, lang) {
  const c = dealCopy.copy(lang);
  const current = tenders.status(order);
  const publication = tenders.publication(order);
  const status = publication === 'in_review' ? c('resume_review') : c('deal_' + current);
  const offerCount = publication === 'published' ? (await offers.listForOrder(order.id)).length : null;
  return { id: order.id, status, offerCount, prompt: require('../services/resumeLink.service').chatPrompt(order, lang) };
}

async function resumePage(req, res, extra = {}) {
  const found = await require('../services/resumeLink.service').resolve(req.params.token);
  const lang = pageLang(req, found?.order?.source_lang);
  const c = dealCopy.copy(lang);
  if (!found || found.expired) return renderPage(res, found?.expired ? 410 : 404, 'expired', lang, { message: c('resume_expired') });
  return renderPage(res, extra.status || 200, 'resume', lang, { resume: await resumeView(found.order, lang), token: req.params.token,
    langHref: `/t/${req.params.token}?lang=`, ...extra });
}

const RESEND_LIMIT = 3;
async function resumeSendLink(req, res) {
  const found = await require('../services/resumeLink.service').resolve(req.params.token);
  const lang = pageLang(req, found?.order?.source_lang);
  const c = dealCopy.copy(lang);
  if (!found || found.expired) return renderPage(res, 404, 'expired', lang, { message: c('resume_expired') });
  const order = found.order;
  // Не больше трёх SMS со ссылкой в час на заявку: страница открыта любому, у кого есть ссылка.
  const redis = require('../config/redis');
  const key = `resume_resend:${order.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60 * 60);
  if (count > RESEND_LIMIT) return resumePage(req, res, { status: 429, error: c('error_generic') });
  const serviceMessage = require('../config/service-message-copy');
  await require('../services/sms.service').sendOrderNotification(order.phone,
    serviceMessage.sms('orderLink', { id: order.id, link: `${require('../config/url').getBaseUrl()}/o/${order.owner_token}` }), { orderId: order.id, kind: 'transactional' })
    .catch((error) => console.error('Resume link SMS failed:', error.message));
  return resumePage(req, res, { sent: c('resume_link_sent', { phone: require('../services/account.service').maskedPhone(order.phone) || '' }) });
}

module.exports = { isDealOrder, pageLocals, action, offerInput, localTime, consentPage, consentSubmit, resumePage: (req, res) => resumePage(req, res), resumeSendLink };
