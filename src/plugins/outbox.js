const fp = require('fastify-plugin');
const { Outbox } = require('../outbox');

// Own the directory before the Actual connector opens its persistent cache.
module.exports = fp(async (app) => {
  const c = app.config;
  const outbox = new Outbox({ directory: c.DATA_DIR,
    budget: JSON.stringify([c.ACTUAL_URL.replace(/\/+$/, ''), c.ACTUAL_SYNC_ID]),
    maxPending: c.QUEUE_MAX_PENDING, retryMs: c.QUEUE_RETRY_MS, payloadDays: c.COMPLETED_PAYLOAD_DAYS });
  app.decorate('outbox', outbox);
  // Workers are closed by the delivery plugin before Actual shuts down.
  app.addHook('onClose', () => outbox.close());
});
