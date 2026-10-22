// Контракт API v1 не расходится с кодом: каждый маршрут /api/v1 описан в OpenAPI и наоборот; раздаваемый
// /api/v1/openapi.json содержит только сделанное; каждое действие /capabilities ссылается на операцию контракта
// (сделанное — на сделанную, несделанное — на запланированную); docs/api-v1/openapi.yaml собран из текущего кода.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const harness = require('./api-v1-harness');

(async () => {
  const openapi = require('../src/config/openapiV1');
  const { ACTIONS } = require('../src/config/apiCapabilities');
  const full = openapi.spec();
  const served = openapi.served();

  // 1. Маршруты роутера ↔ сделанные операции.
  const router = require('../src/routes/apiV1.routes');
  const routes = router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods)
    .map((method) => `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`)).filter((route) => route !== 'GET /openapi.json').sort();
  const documented = Object.entries(served.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)).sort();
  assert.deepEqual(routes, documented, 'маршруты и контракт совпадают');

  // 2. В раздаваемом контракте нет запланированного; в полном — каждая операция помечена.
  const operations = (spec) => Object.values(spec.paths).flatMap((item) => Object.values(item));
  assert.ok(operations(served).every((op) => op['x-xtender-status'] === 'implemented'));
  assert.ok(operations(full).every((op) => ['implemented', 'planned'].includes(op['x-xtender-status']) && Number.isInteger(op['x-xtender-stage'])));
  const ids = operations(full).map((op) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationId уникальны');

  // 3. Действия /capabilities ↔ операции контракта.
  const byId = new Map(operations(full).map((op) => [op.operationId, op]));
  for (const action of ACTIONS) {
    const op = byId.get(action.operation_id);
    assert.ok(op, 'нет операции ' + action.operation_id);
    assert.equal(op['x-xtender-status'], action.implemented ? 'implemented' : 'planned', action.id);
    assert.equal(op['x-xtender-stage'], action.stage, action.id);
    const scopes = (op.security || []).flatMap((s) => s.oauth2 || []);
    assert.deepEqual([...new Set(scopes)].sort(), [...action.scopes].sort(), 'области ' + action.id);
  }
  // Каждая ссылка на схему существует.
  const refs = JSON.stringify(full).match(/#\/components\/schemas\/\w+/g);
  for (const ref of new Set(refs)) assert.ok(full.components.schemas[ref.split('/').pop()], ref);
  // Действия с внешним эффектом этапов 2–3 требуют Idempotency-Key (кроме PUT/DELETE/PATCH, которые повторяемы сами).
  for (const [path, item] of Object.entries(full.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'post' && op['x-xtender-side-effects'] && op['x-xtender-status'] === 'planned') {
        assert.ok(op.parameters.some((p) => p.name === 'Idempotency-Key'), `${method} ${path}: Idempotency-Key`);
      }
    }
  }

  // 4. YAML в docs собран из этого же кода.
  const { build, OUT } = require('../scripts/build-openapi-yaml');
  // git на Windows может выдать файл с CRLF: сравниваем содержимое, а не окончания строк.
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), build(), 'docs/api-v1/openapi.yaml устарел: node scripts/build-openapi-yaml.js');

  // 5. Сервер отдаёт тот же раздаваемый контракт.
  const { server, base } = await harness.start();
  try {
    const response = await fetch(base + '/api/v1/openapi.json');
    const body = await response.json();
    assert.equal(body.openapi, '3.1.0');
    assert.deepEqual(Object.keys(body.paths).sort(), Object.keys(served.paths).sort());
    assert.equal(body.servers[0].url, base + '/api/v1');
    assert.equal(body.components.securitySchemes.oauth2.flows.authorizationCode.authorizationUrl, base + '/oauth/authorize');
  } finally {
    server.close();
  }
  process.stdout.write('api v1 openapi tests passed\n');
})().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
