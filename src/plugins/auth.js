const fp = require('fastify-plugin');
const { createHash, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');

const digest = (key) => createHash('sha256').update(key).digest();

module.exports = fp(async (app) => {
  const normalizeIp = (ip) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const allowedIps = (app.config.ALLOWED_CLIENT_IPS || '').split(',').map((ip) => ip.trim()).filter(Boolean);
  if (allowedIps.some((ip) => !isIP(ip))) throw new Error('ALLOWED_CLIENT_IPS must be a comma-separated list of IP addresses');
  let devices;
  try { devices = JSON.parse(app.config.API_KEYS || '[]'); }
  catch { throw new Error('API_KEYS must be a JSON array of device credentials'); }
  if (!Array.isArray(devices) || devices.length > 32) throw new Error('API_KEYS must contain at most 32 devices');
  const ids = new Set(['legacy']);
  const secrets = new Set();
  const keys = [];
  if (app.config.API_KEY) {
    keys.push({ id: 'legacy', hash: digest(app.config.API_KEY), accounts: null });
    secrets.add(app.config.API_KEY);
  }
  for (const device of devices) {
    if (!device || typeof device.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(device.id) || ids.has(device.id) ||
        typeof device.key !== 'string' || device.key.length < 32 || secrets.has(device.key) ||
        (device.accounts !== undefined && (!Array.isArray(device.accounts) ||
          device.accounts.some((name) => typeof name !== 'string' || !name.trim())))) {
      throw new Error('API_KEYS contains an invalid or duplicate device, key, or account scope');
    }
    ids.add(device.id);
    secrets.add(device.key);
    keys.push({ id: device.id, hash: digest(device.key), accounts: device.accounts?.map((s) => s.toLowerCase()) ?? null });
  }
  if (!keys.length) throw new Error('Set API_KEY or API_KEYS');
  app.decorateRequest('device', null);
  app.addHook('onRequest', async (request, reply) => {
    // Use the TCP peer, never spoofable X-Forwarded-For / CF-Connecting-IP headers.
    if (allowedIps.length && !allowedIps.includes(normalizeIp(request.socket.remoteAddress))) {
      return reply.code(403).send({ error: 'Direct access is not permitted' });
    }
    // Match the route, not an attacker-controlled query string.
    if (request.routeOptions.url === '/health') return;
    const supplied = request.headers['x-api-key'];
    if (typeof supplied !== 'string' || supplied.length > 1024) return reply.code(401).send({ error: 'Unauthorized' });
    const candidate = digest(supplied);
    let match;
    for (const key of keys) if (timingSafeEqual(candidate, key.hash)) match = key;
    if (!match) return reply.code(401).send({ error: 'Unauthorized' });
    request.device = { id: match.id, accounts: match.accounts };
  });
});
