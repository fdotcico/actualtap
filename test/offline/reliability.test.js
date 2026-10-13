const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, send, tempDir } = require('./helpers');
const { Outbox } = require('../../src/outbox');

test('concurrent retries create one transaction and return the same identifier', async (t) => {
  const { app, control } = await build(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => send(app)));
  assert.ok(responses.every((r) => r.statusCode === 200));
  assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
  assert.equal(control.adds, 1);
  assert.equal(responses[0].json().amount, -1234);
  assert.equal((await send(app, 'event-00001', { amount: 30 })).statusCode, 409);
});

test('legacy calls work and distinct operations with equal amounts remain distinct', async (t) => {
  const { app, control } = await build(t);
  await send(app, null); await send(app, null);
  await send(app, 'different-one'); await send(app, 'different-two');
  assert.equal(control.adds, 4);
});

test('offline requests survive restart and automatically retry with the original identifier', async (t) => {
  const directory = tempDir(t);
  const first = await build(t, { directory, control: { offline: true } });
  const response = await send(first.app);
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, 'queued');
  const id = response.json().id;
  await first.app.close();
  const next = await build(t, { directory });
  await new Promise((r) => setTimeout(r, 5));
  await next.outbox.tick();
  const retry = await send(next.app);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().id, id);
  assert.equal(next.control.adds, 1);
});

test('lost sync acknowledgement does not add the transaction again', async (t) => {
  const { app, control, outbox } = await build(t, { control: { lostAck: true } });
  const first = await send(app);
  assert.equal(first.statusCode, 202);
  await new Promise((r) => setTimeout(r, 5));
  await outbox.tick();
  assert.equal((await send(app)).json().status, 'synced');
  assert.equal(control.adds, 1);
});

test('recovery after remote success and a local crash does not resurrect a deleted transaction', async (t) => {
  const directory = tempDir(t);
  const records = new Map();
  const first = await build(t, { directory, records });
  const response = await send(first.app);
  const id = response.json().id;
  first.outbox.db.prepare("UPDATE requests SET state = 'pending' WHERE id = ?").run(id);
  records.set(id, { id, tombstone: true });
  await first.app.close();
  const next = await build(t, { directory, records });
  await next.outbox.tick();
  await next.outbox.tail;
  assert.equal(next.outbox.get(id).state, 'synced');
  assert.equal(next.control.adds, 0);
  assert.equal(records.get(id).tombstone, true);
});

test('old completed payloads are removed but idempotency tombstones remain', async (t) => {
  let now = Date.now();
  const { app, outbox, control } = await build(t, { outboxOptions: { clock: () => now, payloadDays: 1 } });
  const id = (await send(app)).json().id;
  now += 2 * 86400000;
  await outbox.tick();
  assert.equal(outbox.get(id).payload, null);
  const replay = await send(app);
  assert.equal(replay.json().id, id);
  assert.equal(replay.json().status, 'synced');
  assert.equal(control.adds, 1);
});

test('pending capacity rejects new work but allows an existing operation to be polled', async (t) => {
  const { app } = await build(t, { control: { offline: true }, outboxOptions: { maxPending: 1 } });
  assert.equal((await send(app)).statusCode, 202);
  assert.equal((await send(app, 'other-event')).statusCode, 503);
  assert.equal((await send(app)).statusCode, 202);
});

test('a persistent volume is bound to its original budget', async (t) => {
  const directory = tempDir(t);
  const first = new Outbox({ directory, budget: 'one' });
  await first.close();
  assert.throws(() => new Outbox({ directory, budget: 'two' }), /another Actual server or budget/);
});

test('a second process cannot concurrently own the same volume', async (t) => {
  const directory = tempDir(t);
  const first = new Outbox({ directory, budget: 'one' });
  try { assert.throws(() => new Outbox({ directory, budget: 'one' }), /locked/); }
  finally { await first.close(); }
});

test('location remains optional and is never duplicated on replay', async (t) => {
  const { app, locations } = await build(t);
  const body = { latitude: 45, longitude: 9 };
  assert.equal((await send(app, 'location-event', body)).statusCode, 200);
  await send(app, 'location-event', body);
  assert.equal(locations.filter((r) => r.name === 'api/payee-location-create').length, 1);
  assert.equal((await send(app, 'bad-location', { latitude: 45 })).statusCode, 400);
});

test('invalid dates, nonfinite/negative amounts and inconsistent operation keys are rejected', async (t) => {
  const { app, control } = await build(t);
  for (const body of [{ date: '2026-02-31' }, { amount: 'invalid' }, { amount: -2 }, { eventId: 'mismatched-event' }]) {
    assert.equal((await send(app, 'validation-event', body)).statusCode, 400);
  }
  assert.equal((await send(app, 'bad key with spaces')).statusCode, 400);
  assert.equal(control.adds, 0);
});

test('device keys restrict accounts and hide other devices transactions', async (t) => {
  const phone1 = 'a'.repeat(40), phone2 = 'b'.repeat(40);
  const { app } = await build(t, { devices: [
    { id: 'iphone-1', key: phone1, accounts: ['Checking'] },
    { id: 'iphone-2', key: phone2, accounts: ['Savings'] },
  ] });
  assert.equal((await send(app, 'phone-event', { account: 'Savings' }, phone1)).statusCode, 403);
  const response = await send(app, 'phone-event', {}, phone1);
  assert.equal(response.statusCode, 200);
  const url = '/transactions/' + response.json().id;
  assert.equal((await app.inject({ url, headers: { 'x-api-key': phone2 } })).statusCode, 404);
  assert.equal((await app.inject({ url, headers: { 'x-api-key': phone1 } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/status' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
});

test('authentication runs before transaction validation and rejects wrong keys', async (t) => {
  const { app } = await build(t);
  assert.equal((await app.inject({ method: 'POST', url: '/transaction', payload: {} })).statusCode, 401);
  assert.equal((await send(app, 'valid-event', {}, 'incorrect')).statusCode, 401);
});

test('network restrictions use the real peer address and cannot be bypassed by headers', async (t) => {
  const { app } = await build(t, { allowedIps: '127.0.0.1,172.28.0.1' });
  const headers = { 'x-api-key': 'legacy-test-key', 'x-forwarded-for': '172.28.0.1', 'cf-connecting-ip': '172.28.0.1' };
  assert.equal((await app.inject({ url: '/status', remoteAddress: '192.168.1.42', headers })).statusCode, 403);
  assert.equal((await app.inject({ url: '/status', remoteAddress: '::ffff:172.28.0.1', headers })).statusCode, 200);
});

test('storage failure before durable acceptance is not reported as success', async (t) => {
  const { app, outbox, control } = await build(t);
  t.mock.method(outbox, 'enqueue', () => { throw new Error('Disk full with private detail'); });
  const response = await send(app);
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes('private detail'));
  assert.equal(control.adds, 0);
});

test('transaction details and credentials do not appear in application logs', async (t) => {
  const lines = [];
  const { app } = await build(t, { logger: { stream: { write(line) { lines.push(line); } } } });
  await send(app, 'privacy-event', { payee: 'PRIVATE-MERCHANT', notes: 'PRIVATE-NOTE', latitude: 44.123456, longitude: 9 });
  const output = lines.join('');
  for (const value of ['PRIVATE-MERCHANT', 'PRIVATE-NOTE', '44.123456', 'legacy-test-key']) assert.ok(!output.includes(value));
});

test('SQLite WAL recovers an acknowledged enqueue after abrupt process exit', async (t) => {
  const { spawnSync } = require('node:child_process');
  const directory = tempDir(t);
  const script = `const { Outbox } = require(${JSON.stringify(require.resolve('../../src/outbox'))});
    const box = new Outbox({ directory: process.argv[1], budget: 'crash-test' });
    box.enqueue({ device: 'phone', key: 'crash-event', fingerprint: 'hash', payload: { accountId: 'account', transaction: { amount: -100 } } });
    process.exit(0);`;
  const result = spawnSync(process.execPath, ['-e', script, directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const recovered = new Outbox({ directory, budget: 'crash-test' });
  try {
    const row = recovered.lookup('phone', 'crash-event');
    assert.equal(row.state, 'pending');
    assert.equal(JSON.parse(row.payload).transaction.amount, -100);
  } finally { await recovered.close(); }
});
