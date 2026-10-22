// API v1 (/api/v1): этап 1 ТЗ «API для плагина ChatGPT». Контракт — src/config/openapiV1.js (он же
// docs/api-v1/openapi.yaml), описание — docs/api-v1/README.md. Каждый маршрут здесь должен быть в контракте:
// это проверяет tests/api-v1-openapi.test.js.
const express = require('express');
const api = require('../middleware/apiV1');
const controller = require('../controllers/apiV1.controller');
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

// Только в песочнице (XTENDER_SANDBOX=1): SMS, которые ушли бы на номер, вместо настоящей отправки.
router.get('/sandbox/sms', wrap(controller.sandboxSms));

router.use(api.notFound);
router.use(api.errorHandler);

module.exports = router;
