const { hash } = require("../outbox");

const transactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        amount: { type: ["number", "string"], default: 0 },
        payee: { type: "string", maxLength: 500, default: "Unknown" },
        account: { type: "string", minLength: 1, maxLength: 200 },
        eventId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
        notes: { type: "string", maxLength: 4000 },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        type: {
          type: "string",
          enum: ["payment", "deposit"],
          default: "payment",
        },
      },
      required: ["account"],
    },
  },
};

// The schema pattern guarantees YYYY-MM-DD shape; this catches impossible
// dates like 2026-02-31 that a Date round-trip silently rolls over
const isValidDate = (dateStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

// iOS Shortcuts passes the Tap-to-Pay amount as locale-formatted text, so the
// string may carry a currency symbol and use either "," or "." as the decimal
// separator (e.g. "£12.34", "12,34", "1.234,56 €")
const parseAmount = (raw) => {
  let value = raw.replace(/[^\d.,-]/g, "");
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal separator, the other is a thousands separator
    value =
      lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma > -1) {
    const isDecimalComma = value.indexOf(",") === lastComma && value.length - lastComma - 1 !== 3;
    value = isDecimalComma ? value.replace(",", ".") : value.replace(/,/g, "");
  }

  return /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
};

const createTransaction = (request) => {
  const { payee, amount: rawAmount, notes, date, type = "payment" } = request.body;
  const amount = typeof rawAmount === "string" ? parseAmount(rawAmount) : rawAmount;
  const isDeposit = type === "deposit";
  const transactionAmount = amount !== undefined && !isNaN(amount) ? Math.round(amount * 100) * (isDeposit ? 1 : -1) : 0;

  return {
    payee_name: payee || "Unknown",
    amount: transactionAmount,
    notes: notes || "",
    date: date || new Date().toLocaleDateString('en-CA'),
    cleared: false,
  };
};

const waitBriefly = async (work) => {
  let timer;
  try { await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, 4000); })]); }
  finally { clearTimeout(timer); }
};

module.exports = async (app) => {
  app.post('/transaction', transactionSchema, async (request, reply) => {
    const { latitude, longitude, eventId } = request.body;
    const hasLocation = latitude !== undefined || longitude !== undefined;
    if (hasLocation && (latitude === undefined || longitude === undefined)) {
      return reply.code(400).send({ error: 'latitude and longitude must be provided together' });
    }
    if (request.body.date && !isValidDate(request.body.date)) return reply.code(400).send({ error: 'Invalid calendar date' });
    const headerKey = request.headers['idempotency-key'];
    if (headerKey !== undefined && (typeof headerKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(headerKey))) {
      return reply.code(400).send({ error: 'Idempotency-Key must contain 8-128 letters, digits, underscores or hyphens' });
    }
    if (eventId && headerKey && eventId !== headerKey) return reply.code(400).send({ error: 'eventId and Idempotency-Key must match' });
    const key = headerKey || eventId;
    const account = request.body.account.toLowerCase();
    if (request.device.accounts && !request.device.accounts.includes(account)) return reply.code(403).send({ error: 'Account not permitted for this device' });
    const amount = typeof request.body.amount === 'string' ? parseAmount(request.body.amount) : request.body.amount;
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) {
      return reply.code(400).send({ error: 'Amount must be a non-negative finite value in major currency units' });
    }
    const transaction = createTransaction(request);
    // Preserve the omission of date in the fingerprint, so retries across midnight match.
    const fingerprint = hash(JSON.stringify({ ...transaction, date: request.body.date || null, account,
      type: request.body.type, latitude: latitude ?? null, longitude: longitude ?? null }));
    const existing = key ? app.outbox.lookup(request.device.id, key) : null;
    let accountId;
    if (!existing) {
      const accounts = await app.actual.getAccounts();
      accountId = accounts.find((a) => !a.closed && a.name.toLowerCase() === account)?.id;
      if (!accountId) return reply.code(400).send({ error: 'Invalid or closed account' });
    }
    let accepted;
    try {
      accepted = app.outbox.enqueue({ device: request.device.id, key, fingerprint,
        payload: { accountId, transaction, location: hasLocation ? { latitude, longitude } : null } });
    } catch (error) {
      const status = error.statusCode || 503;
      return reply.code(status).send({ error: status === 409 ? error.message : 'Request was not accepted; check storage or retry later with the same idempotency key' });
    }
    await waitBriefly(app.outbox.attempt(accepted.row.id));
    const row = app.outbox.get(accepted.row.id);
    const queued = row.state !== 'synced';
    request.log.info({ transactionId: row.id, device: request.device.id, status: row.state, replayed: accepted.replayed }, 'Transaction request handled');
    reply.header('Location', `/transactions/${row.id}`);
    if (queued) reply.header('Retry-After', '5');
    return reply.code(queued ? 202 : 200).send({ ...app.outbox.response(row), replayed: accepted.replayed });
  });

  app.get('/transactions/:id', async (request, reply) => {
    const row = app.outbox.get(request.params.id);
    if (!row || row.device !== request.device.id) return reply.code(404).send({ error: 'Not found' });
    return { ...app.outbox.response(row), attempts: row.attempts, lastError: row.last_error };
  });
  app.get('/status', async (request) => app.outbox.stats(request.device.id));
};
