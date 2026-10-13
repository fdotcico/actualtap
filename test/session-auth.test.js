const { test } = require('node:test');
const assert = require('node:assert/strict');
const fastify = require('fastify');
const fs = require('node:fs');

function configureEnv(t, overrides = {}) {
  const values = {
    API_KEY: 'test-key', ACTUAL_URL: 'http://actual.invalid:5006',
    ACTUAL_SYNC_ID: 'test-budget', ACTUAL_SESSION_TOKEN: 'test-session',
    ACTUAL_PASSWORD: undefined, ACTUAL_ENCRYPTION_PASSWORD: '', ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test('session token configuration works without an Actual password', async (t) => {
  configureEnv(t);
  const app = fastify();
  t.after(() => app.close());
  await app.register(require('../src/plugins/env'));
  await app.ready();
  assert.equal(app.config.ACTUAL_SESSION_TOKEN, 'test-session');
});

test('a password alone cannot replace the required session token', async (t) => {
  configureEnv(t, { ACTUAL_SESSION_TOKEN: undefined, ACTUAL_PASSWORD: 'test-password' });
  const app = fastify();
  t.after(() => app.close());
  app.register(require('../src/plugins/env'));
  await assert.rejects(app.ready(), /ACTUAL_SESSION_TOKEN/);
});

test('connector passes the session token to Actual and opens the configured budget', async (t) => {
  configureEnv(t);
  let initOptions;
  let downloadedBudget;
  let shutDown = false;
  const internal = { send: async () => {} };
  const api = {
    init: async (options) => { initOptions = options; return internal; },
    getBudgets: async () => [{ groupId: 'test-budget' }],
    downloadBudget: async (id) => { downloadedBudget = id; },
    getAccounts: async () => [],
    shutdown: async () => { shutDown = true; },
  };
  const apiPath = require.resolve('@actual-app/api');
  const connectorPath = require.resolve('../src/plugins/actualConnector');
  const previousApi = require.cache[apiPath];
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api };
  delete require.cache[connectorPath];
  t.after(() => {
    delete require.cache[connectorPath];
    if (previousApi) require.cache[apiPath] = previousApi;
    else delete require.cache[apiPath];
  });
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }));
  t.mock.method(fs, 'mkdtempSync', () => 'mock-data-dir');
  // Initialization races a timeout; fake timers avoid leaving its 30s timer alive.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fastify();
  t.after(() => app.close());
  app.register(require('../src/plugins/env'));
  app.register(require('../src/plugins/actualConnector'));
  await app.ready();
  assert.equal(initOptions.sessionToken, 'test-session');
  assert.equal(initOptions.serverURL, 'http://actual.invalid:5006');
  assert.equal(Object.hasOwn(initOptions, 'password'), false);
  assert.equal(downloadedBudget, 'test-budget');
  assert.equal(app.actualInternal, internal);
  await app.close();
  assert.equal(shutDown, true);
});
