const { test } = require('node:test');
const assert = require('node:assert/strict');
const fastify = require('fastify');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');

for (const devices of [
  [{ key: 'a'.repeat(40) }],
  [{ id: 'phone', key: 'short' }],
  [{ id: 'phone', key: 'a'.repeat(40) }, { id: 'phone', key: 'b'.repeat(40) }],
  [{ id: 'phone-1', key: 'a'.repeat(40) }, { id: 'phone-2', key: 'a'.repeat(40) }],
]) test('invalid or duplicate device credential configuration fails closed', async (t) => {
  const app = fastify();
  t.after(() => app.close());
  app.decorate('config', { API_KEYS: JSON.stringify(devices) });
  app.register(require('../../src/plugins/auth'));
  await assert.rejects(app.ready(), /invalid or duplicate/);
});

test('device credentials can be loaded from a private JSON file', async (t) => {
  const file = path.join(tempDir(t), 'keys.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'phone', key: 'a'.repeat(40) }]));
  const overrides = { API_KEYS_FILE: file, API_KEYS: '[]', ACTUAL_URL: 'http://actual.invalid', ACTUAL_SYNC_ID: 'budget', ACTUAL_PASSWORD: 'test-password' };
  for (const [key, value] of Object.entries(overrides)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const app = fastify();
  t.after(() => app.close());
  app.register(require('../../src/plugins/env'));
  app.register(require('../../src/plugins/auth'));
  app.get('/status', async () => ({ ok: true }));
  await app.ready();
  assert.equal((await app.inject({ url: '/status', headers: { 'x-api-key': 'a'.repeat(40) } })).statusCode, 200);
});
