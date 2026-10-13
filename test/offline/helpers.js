const fastify = require('fastify');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Outbox } = require('../../src/outbox');

const resources = new Map();
function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actualtap-test-'));
  resources.set(directory, []);
  t.after(async () => {
    for (const close of resources.get(directory)) await close();
    resources.delete(directory);
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function build(t, options = {}) {
  const directory = options.directory || tempDir(t);
  const app = fastify({ logger: options.logger || false, bodyLimit: 16384, ajv: { customOptions: { allowUnionTypes: true } } });
  const control = { offline: false, lostAck: false, adds: 0, ...options.control };
  const records = options.records || new Map();
  const locations = [];
  const actual = {
    sync: async () => {
      if (control.offline) throw new Error('Simulated network failure');
      if (control.lostAck && control.adds) { control.lostAck = false; throw new Error('Simulated lost acknowledgement'); }
    },
    getAccounts: async () => [{ id: 'account-1', name: 'Checking' }, { id: 'account-2', name: 'Savings' }],
    q: () => ({ withDead() { this.dead = true; return this; }, filter(value) { this.id = value.id; return this; }, select() { return this; } }),
    runQuery: async (q) => ({ data: records.has(q.id) ? [records.get(q.id)] : [] }),
    addTransactions: async (account, transactions) => {
      control.adds++;
      for (const transaction of transactions) records.set(transaction.id, { ...transaction, account });
      return 'ok';
    },
    getPayees: async () => [{ id: 'payee-1', name: 'Cafe' }],
  };
  app.decorate('config', { ALLOWED_CLIENT_IPS: options.allowedIps || '', API_KEY: 'legacy-test-key', API_KEYS: JSON.stringify(options.devices || []), QUEUE_RETRY_MS: 300000 });
  app.decorate('actual', actual);
  app.decorate('actualInternal', { send: async (name, args) => {
    locations.push({ name, args });
    return name === 'api/payees-get-nearby' ? options.nearby || [] : undefined;
  } });
  const outbox = new Outbox({ directory, budget: 'test-budget', retryMs: 1, ...options.outboxOptions });
  app.decorate('outbox', outbox);
  app.register(require('../../src/plugins/auth'));
  app.register(require('../../src/plugins/delivery'));
  app.register(require('../../src/routes/transaction'));
  app.register(require('../../src/routes/health'));
  resources.get(directory)?.push(() => app.close());
  await app.ready();
  return { app, control, records, directory, locations, outbox };
}

function send(app, key = 'event-00001', body = {}, apiKey = 'legacy-test-key') {
  return app.inject({ method: 'POST', url: '/transaction',
    headers: { 'x-api-key': apiKey, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { account: 'Checking', amount: '12,34', payee: 'Cafe', ...body } });
}
module.exports = { build, send, tempDir };
