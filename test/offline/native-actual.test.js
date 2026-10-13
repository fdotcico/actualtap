const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const actual = require('@actual-app/api');
const { deliver } = require('../../src/plugins/delivery');

test('real Actual API preserves our ID and finds deleted records during replay', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actualtap-native-'));
  t.after(async () => {
    await actual.shutdown();
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temp directory');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const internal = await actual.init({ dataDir });
  await internal.send('create-budget', { budgetName: 'Disposable offline test', avoidUpload: true });
  const accountId = await actual.createAccount({ name: 'Checking' }, 0);
  // No remote server is configured: test Actual's real SQLite and query behavior.
  t.mock.method(actual, 'sync', async () => {});
  const app = { actual, actualInternal: internal, log: { warn() {} } };
  const transaction = { id: randomUUID(), date: '2026-10-13', amount: -1234, payee_name: 'Test Cafe', cleared: false };
  const payload = { accountId, transaction };
  await deliver(app, payload);
  await deliver(app, payload);
  assert.equal((await actual.getTransactions(accountId)).filter((x) => x.id === transaction.id).length, 1);
  await actual.deleteTransaction(transaction.id);
  await deliver(app, payload);
  assert.equal((await actual.getTransactions(accountId)).filter((x) => x.id === transaction.id).length, 0);
  const dead = await actual.runQuery(actual.q('transactions').withDead().filter({ id: transaction.id }).select(['id', 'tombstone']));
  assert.equal(dead.data.length, 1);
  assert.equal(dead.data[0].tombstone, true);
});
