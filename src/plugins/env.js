const fastifyEnv = require('@fastify/env');
const fp = require('fastify-plugin');
const fs = require('node:fs');

module.exports = fp(async (fastify) => {
  await fastify.register(fastifyEnv, {
    data: process.env,
    schema: {
      type: 'object',
      required: ['ACTUAL_URL', 'ACTUAL_SYNC_ID'],
      properties: {
        API_KEY: { type: 'string', default: '' },
        API_KEYS: { type: 'string', default: '[]' },
        API_KEYS_FILE: { type: 'string', default: '' },
        ALLOWED_CLIENT_IPS: { type: 'string', default: '' },
        ACTUAL_URL: { type: 'string', minLength: 1 },
        ACTUAL_SYNC_ID: { type: 'string', minLength: 1 },
        ACTUAL_PASSWORD: { type: 'string', default: '' },
        ACTUAL_SESSION_TOKEN: { type: 'string', default: '' },
        ACTUAL_ENCRYPTION_PASSWORD: { type: 'string', default: '' },
        DATA_DIR: { type: 'string', default: './data' },
        QUEUE_MAX_PENDING: { type: 'integer', minimum: 1, maximum: 100000, default: 10000 },
        QUEUE_RETRY_MS: { type: 'integer', minimum: 1000, maximum: 300000, default: 5000 },
        COMPLETED_PAYLOAD_DAYS: { type: 'integer', minimum: 0, maximum: 365, default: 7 },
      },
    },
  });
  const c = fastify.config;
  if (c.API_KEYS_FILE) {
    if (c.API_KEYS !== '[]') throw new Error('Set either API_KEYS or API_KEYS_FILE');
    if (fs.statSync(c.API_KEYS_FILE).size > 65536) throw new Error('API_KEYS_FILE is too large');
    c.API_KEYS = fs.readFileSync(c.API_KEYS_FILE, 'utf8');
  }
  if (!c.ACTUAL_SESSION_TOKEN && !c.ACTUAL_PASSWORD) {
    throw new Error('Set ACTUAL_SESSION_TOKEN or ACTUAL_PASSWORD');
  }
  if (!c.DATA_DIR.trim()) throw new Error('DATA_DIR must not be empty');
});
