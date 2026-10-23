// API v1 (/api/v1): этап 1 ТЗ «API для плагина ChatGPT». Контракт — src/config/openapiV1.js (он же
// docs/api-v1/openapi.yaml), описание — docs/api-v1/README.md. Каждый маршрут здесь должен быть в контракте:
// это проверяет tests/api-v1-openapi.test.js.
const express = require('express');
const api = require('../middleware/apiV1');
const controller = require('../controllers/apiV1.controller');
const deal = require('../controllers/apiDeal.controller');
const wrap = require('../middleware/asyncHandler');
const openapi = require('../config/openapiV1');

const router = express.Router();
const optional = api.authenticate({ optional: true });
const required = api.authenticate();

router.use(api.requestId);

router.get('/openapi.json', (req, res) => { api.publicCache(res, 300); res.json(openapi.served()); });
router.get('/capabilities', optional, wrap(controller.capabilities));

router.get('/me', required, api.requireScope('profile:read'), wrap(controller.getMe));
router.patch('/me', required, api.requireScope('profile:write'), api.requireActiveAccount, wrap(controller.updateMe));
router.get('/me/provider-profile', required, api.requireScope('profile:read'), wrap(controller.getProviderProfile));
router.put('/me/provider-profile', required, api.requireScope('profile:write'), api.requireActiveAccount, wrap(controller.updateProviderProfile));
router.get('/me/sessions', required, api.requireScope('profile:read'), wrap(controller.listSessions));
// Отключить приложение может и отключённый аккаунт: отказ от доступа запрещать нельзя.
router.delete('/me/sessions/:id', required, api.requireScope('profile:write'), wrap(controller.revokeSession));

router.get('/categories', optional, wrap(controller.searchCategories));
router.get('/categories/:id/schema', optional, wrap(controller.getCategorySchema));
router.get('/locations', optional, wrap(controller.listLocations));
router.get('/units', optional, wrap(controller.listUnits));

// Сделка (docs/api-v1/WORKFLOWS.md). Запись — только действующему аккаунту; действия с внешним эффектом — с Idempotency-Key.
const scope = api.requireScope;
const write = [api.requireActiveAccount];
const once = api.idempotent();
router.post('/tenders', required, scope('tenders:write'), write, once, wrap(deal.createTender));
router.get('/tenders/resolve', required, scope('tenders:read'), wrap(deal.resolveTender));
router.get('/tenders/:id', required, scope('tenders:read'), wrap(deal.getTender));
router.patch('/tenders/:id', required, scope('tenders:write'), write, wrap(deal.updateTender));
router.post('/tenders/:id/validate', required, scope('tenders:read'), wrap(deal.validateTender));
router.post('/tenders/:id/publish', required, scope('tenders:write'), write, once, wrap(deal.publishTender));
router.post('/tenders/:id/response-mode', required, scope('tenders:write'), write, once, wrap(deal.setResponseMode));
router.get('/me/tenders', required, scope('tenders:read'), wrap(deal.listMyTenders));
router.get('/tenders/:id/status', required, scope('tenders:read'), wrap(deal.tenderStatus));
router.post('/tenders/:id/close', required, scope('tenders:write'), write, once, wrap(deal.closeTender));
router.post('/tenders/:id/cancel', required, scope('tenders:write'), write, once, wrap(deal.cancelTender));
router.post('/tenders/:id/complete', required, scope('tenders:write'), write, once, wrap(deal.completeTender));
router.get('/tenders/:id/offers', required, scope('offers:read'), wrap(deal.tenderOffers));
router.post('/tenders/:id/offers', required, scope('offers:write'), write, once, wrap(deal.createOffer));
router.get('/tenders/:id/comparison-data', required, scope('offers:read'), wrap(deal.comparison));
router.post('/tenders/:id/selection', required, scope('offers:write'), write, once, wrap(deal.selectOffer));
router.get('/opportunities', required, scope('tenders:read'), wrap(deal.opportunities));
router.get('/offers/:id', required, scope('offers:read'), wrap(deal.getOffer));
router.patch('/offers/:id', required, scope('offers:write'), write, wrap(deal.updateOffer));
router.post('/offers/:id/submit', required, scope('offers:write'), write, once, wrap(deal.submitOffer));
router.post('/offers/:id/withdraw', required, scope('offers:write'), write, once, wrap(deal.withdrawOffer));
router.get('/me/offers', required, scope('offers:read'), wrap(deal.myOffers));
router.post('/offers/:id/accept-selection', required, scope('offers:write'), write, once, wrap(deal.acceptSelection));
router.post('/offers/:id/decline-selection', required, scope('offers:write'), write, once, wrap(deal.declineSelection));
router.post('/tenders/:id/threads', required, scope('messages:write'), write, once, wrap(deal.createThread));
router.get('/tenders/:id/threads', required, scope('messages:read'), wrap(deal.listThreads));
router.get('/threads/:id/messages', required, scope('messages:read'), wrap(deal.listMessages));
router.post('/threads/:id/messages', required, scope('messages:write'), write, once, wrap(deal.sendMessage));
router.get('/me/notification-preferences', required, scope('profile:read'), wrap(deal.notificationPreferences));
router.patch('/me/notification-preferences', required, scope('notifications:write'), write, wrap(deal.updateNotificationPreferences));
router.put('/tenders/:id/notification-subscription', required, scope('notifications:write'), write, wrap(deal.subscribeTender));
router.delete('/tenders/:id/notification-subscription', required, scope('notifications:write'), wrap(deal.unsubscribeTender));
router.get('/me/notifications', required, scope('profile:read'), wrap(deal.notifications));
router.post('/tenders/:id/resume-link', required, scope('tenders:read'), wrap(deal.resumeLink));

// Только в песочнице (XTENDER_SANDBOX=1): SMS, которые ушли бы на номер, вместо настоящей отправки.
router.get('/sandbox/sms', wrap(controller.sandboxSms));

router.use(api.notFound);
router.use(api.errorHandler);

module.exports = router;
