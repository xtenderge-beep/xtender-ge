// Вход OAuth 2.1 для API v1 и будущего MCP-адаптера (docs/api-v1/AUTH.md): метаданные по RFC 8414 и RFC 9728,
// регистрация клиента по RFC 7591, страница входа по номеру и коду из SMS, обмен кода, отзыв по RFC 7009.
const express = require('express');
const controller = require('../controllers/oauth.controller');
const wrap = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/.well-known/oauth-authorization-server', controller.authorizationServer);
// Корневой адрес читает ChatGPT для MCP-сервера (developers.openai.com/plugins/build/auth): он описывает /mcp.
// REST-клиенты получают свой адрес …/api/v1 в WWW-Authenticate. Токен на любой из ресурсов принимают оба.
router.get('/.well-known/oauth-protected-resource', controller.protectedResource('mcp'));
router.get('/.well-known/oauth-protected-resource/api/v1', controller.protectedResource('api'));
router.get('/.well-known/oauth-protected-resource/mcp', controller.protectedResource('mcp'));

router.post('/oauth/register', wrap(controller.register));
router.get('/oauth/authorize', wrap(controller.authorize));
router.post('/oauth/authorize/phone', wrap(controller.authorizePhone));
router.post('/oauth/authorize/code', wrap(controller.authorizeCode));
router.post('/oauth/authorize/decision', wrap(controller.authorizeDecision));
router.post('/oauth/token', wrap(controller.token));
router.post('/oauth/revoke', wrap(controller.revoke));

module.exports = router;
