const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, send } = require('./helpers');

test('delivery taking five seconds returns synced instead of queued', async (t) => {
  const { app } = await build(t);
  let syncs = 0;
  app.actual.sync = async () => {
    if (++syncs === 2) await new Promise((resolve) => setTimeout(resolve, 5000));
  };
  const response = await send(app);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'synced');
});

test('delivery still pending at ten seconds returns queued and finishes in the background', async (t) => {
  const { app, outbox, control } = await build(t);
  let release;
  const heldSync = new Promise((resolve) => { release = resolve; });
  let syncs = 0;
  app.actual.sync = async () => { if (++syncs === 2) await heldSync; };
  let watchdog;
  try {
    const started = performance.now();
    const response = await Promise.race([
      send(app),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('HTTP response did not finish while delivery was pending')), 15000); }),
    ]);
    assert.ok(performance.now() - started >= 9900, 'The response should wait for the ten-second window');
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, 'queued');
    release();
    await outbox.tail;
    const status = await app.inject({ url: '/transactions/' + response.json().id, headers: { 'x-api-key': 'legacy-test-key' } });
    assert.equal(status.json().status, 'synced');
    assert.equal(control.adds, 1);
  } finally {
    clearTimeout(watchdog);
    release();
    await outbox.tail;
  }
});
