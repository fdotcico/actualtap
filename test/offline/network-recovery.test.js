const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, send } = require('./helpers');

const networkFailure = () => Object.assign(new Error('Private transport details'), { code: 'network-failure' });

test('a transient Actual connection failure recovers in the original HTTP request', async (t) => {
  const lines = [];
  const { app, control, outbox } = await build(t, { logger: { stream: { write(line) { lines.push(line); } } } });
  let syncs = 0;
  app.actual.sync = async () => { if (++syncs === 1) throw networkFailure(); };
  const response = await send(app);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'synced');
  assert.equal((await send(app)).json().id, response.json().id);
  assert.equal(control.adds, 1);
  assert.equal(outbox.get(response.json().id).attempts, 0);
  assert.ok(lines.some((line) => line.includes('retrying delivery once')));
  assert.ok(!lines.join('').includes('Private transport details'));
});

test('a lost final sync acknowledgement recovers without adding the transaction twice', async (t) => {
  const { app, control, records } = await build(t);
  let syncs = 0;
  app.actual.sync = async () => { if (++syncs === 2) throw networkFailure(); };
  const response = await send(app);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'synced');
  assert.equal(control.adds, 1);
  assert.equal(records.size, 1);
  assert.ok(records.has(response.json().id));
});

test('persistent network failure uses one quick retry then the durable queue', async (t) => {
  let now = Date.now();
  const { app, outbox, control } = await build(t, { outboxOptions: { retryMs: 5000, clock: () => now } });
  let syncs = 0;
  app.actual.sync = async () => { syncs++; throw networkFailure(); };
  const response = await send(app);
  const id = response.json().id;
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, 'queued');
  assert.equal(syncs, 2);
  assert.equal(control.adds, 0);
  assert.equal(outbox.get(id).attempts, 1);
  await outbox.tick();
  assert.equal(syncs, 2, 'The normal backoff must still apply');
  app.actual.sync = async () => {};
  now += 5000;
  await outbox.tick();
  assert.equal(outbox.get(id).state, 'synced');
  assert.equal((await send(app)).json().id, id);
  assert.equal(control.adds, 1);
});

test('authentication and other non-network failures do not get a quick retry', async (t) => {
  for (const code of ['unauthorized', 'token-expired', 'out-of-sync', undefined]) {
    await t.test(String(code), async (t) => {
      const { app, control } = await build(t);
      let syncs = 0;
      app.actual.sync = async () => { syncs++; throw Object.assign(new Error('Sync failed'), { code }); };
      assert.equal((await send(app)).statusCode, 202);
      assert.equal(syncs, 1);
      assert.equal(control.adds, 0);
    });
  }
});

test('a slow quick retry respects the ten-second response window and continues in the background', async (t) => {
  const { app, outbox, control } = await build(t);
  let release;
  const heldSync = new Promise((resolve) => { release = resolve; });
  let syncs = 0;
  app.actual.sync = async () => {
    if (++syncs === 1) throw networkFailure();
    if (syncs === 2) await heldSync;
  };
  let watchdog;
  try {
    const response = await Promise.race([
      send(app),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Response waited for blocked recovery')), 15000); }),
    ]);
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, 'queued');
    assert.equal(control.adds, 0);
    release();
    await outbox.tail;
    assert.equal(outbox.get(response.json().id).state, 'synced');
    assert.equal(control.adds, 1);
  } finally {
    clearTimeout(watchdog);
    release();
    await outbox.tail;
  }
});
