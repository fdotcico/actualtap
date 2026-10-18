const fp = require('fastify-plugin');
const { setTimeout: delay } = require('node:timers/promises');

async function deliverOnce(app, { accountId, transaction, location }) {
  // Pull remote state first. Never guess whether a prior timed-out write landed.
  await app.actual.sync();
  const query = app.actual.q('transactions').withDead().filter({ id: transaction.id }).select(['id']);
  const { data } = await app.actual.runQuery(query);
  // Include deleted transactions: a user's deletion must not be resurrected.
  if (data.length === 0) {
    const result = await app.actual.addTransactions(accountId, [transaction]);
    if (result !== 'ok') throw new Error('Actual rejected the transaction');
    if (location) {
      try {
        const payee = (await app.actual.getPayees()).find(({ name }) => name.toLowerCase() === transaction.payee_name.trim().toLowerCase());
        if (payee) {
          const nearby = await app.actualInternal.send('api/payees-get-nearby', { ...location, maxDistance: 500 });
          if (!nearby.some(({ location: item }) => item.payee_id === payee.id)) {
            await app.actualInternal.send('api/payee-location-create', { payeeId: payee.id, ...location });
          }
        }
      } catch { app.log.warn({ transactionId: transaction.id }, 'Optional payee location could not be saved'); }
    }
  }
  await app.actual.sync();
}

async function deliver(app, payload) {
  try {
    await deliverOnce(app, payload);
  } catch (error) {
    // Actual API exposes transport failures as a stable code. Authentication,
    // schema and other errors must keep the outbox's normal backoff.
    if (error?.code !== 'network-failure') throw error;
    app.log.warn({ transactionId: payload.transaction.id }, 'Actual connection failed; retrying delivery once');
    await delay(250);
    // Start with sync + ID lookup again: the failed call may have reached Actual.
    // Await the retry in the same serialized worker; never race two deliveries.
    await deliverOnce(app, payload);
  }
}

module.exports = fp(async (app) => {
  app.outbox.attach((payload) => deliver(app, payload), app.log);
  const tick = () => app.outbox.tick().catch(() => app.log.error('Outbox processing failed; check storage availability'));
  const timer = setInterval(tick, app.config.QUEUE_RETRY_MS || 5000);
  timer.unref();
  app.addHook('onReady', () => { void tick(); });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    // Stop and drain work before the connector's onClose shuts Actual down.
    await app.outbox.close();
  });
});
module.exports.deliver = deliver;
