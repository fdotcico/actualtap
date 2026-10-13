const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = (value) => createHash('sha256').update(value).digest('hex');

class Outbox {
  constructor({ directory, budget, maxPending = 10000, retryMs = 5000, payloadDays = 7, clock = Date.now }) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.maxPending = maxPending;
    this.retryMs = retryMs;
    this.payloadDays = payloadDays;
    this.tail = Promise.resolve();
    this.closing = false;
    const file = path.join(directory, 'outbox.sqlite');
    this.db = new Database(file, { timeout: 1000 });
    try {
      // One application process owns a volume; reject accidental double mounts.
      this.db.pragma('locking_mode = EXCLUSIVE');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, device TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
          fingerprint TEXT NOT NULL, payload TEXT, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, completed_at INTEGER, last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS requests_due ON requests(state, next_attempt);
      `);
      const budgetHash = hash(budget);
      const previous = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('budget');
      if (previous && previous.value !== budgetHash) throw new Error('DATA_DIR belongs to another Actual server or budget; use a separate directory');
      this.db.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)').run('budget', budgetHash);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  enqueue({ device, key, fingerprint, payload }) {
    if (this.closing) throw Object.assign(new Error('Shutting down'), { statusCode: 503 });
    const keyHash = hash(JSON.stringify([device, key || randomUUID()]));
    const existing = this.db.prepare('SELECT * FROM requests WHERE key_hash = ?').get(keyHash);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Idempotency key was already used for a different transaction'), { statusCode: 409 });
      return { row: existing, replayed: true };
    }
    const count = this.db.prepare("SELECT count(*) AS n FROM requests WHERE state = 'pending'").get().n;
    if (count >= this.maxPending) throw Object.assign(new Error('Transaction queue is full; retry later with the same idempotency key'), { statusCode: 503 });
    const id = randomUUID();
    payload = { ...payload, transaction: { ...payload.transaction, id } };
    this.db.prepare('INSERT INTO requests(id, device, key_hash, fingerprint, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, device, keyHash, fingerprint, JSON.stringify(payload), this.clock());
    return { row: this.get(id), replayed: false };
  }

  lookup(device, key) { return this.db.prepare('SELECT * FROM requests WHERE key_hash = ?').get(hash(JSON.stringify([device, key]))); }

  get(id) { return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id); }

  response(row) {
    return { ...(row.payload ? JSON.parse(row.payload).transaction : { id: row.id }), status: row.state === 'synced' ? 'synced' : 'queued' };
  }

  stats(device) {
    const rows = this.db.prepare('SELECT state, count(*) AS count, min(created_at) AS oldest FROM requests WHERE device = ? GROUP BY state').all(device);
    const pending = rows.find((r) => r.state === 'pending');
    return { pending: pending?.count || 0, synced: rows.find((r) => r.state === 'synced')?.count || 0,
      oldestPendingAt: pending ? new Date(pending.oldest).toISOString() : null };
  }

  attach(deliver, logger) { this.deliver = deliver; this.logger = logger; }

  attempt(id) {
    if (this.closing) return this.tail;
    const operation = this.tail.then(async () => {
      const row = this.get(id);
      if (!row || row.state === 'synced' || row.next_attempt > this.clock()) return;
      try {
        await this.deliver(JSON.parse(row.payload));
        this.db.prepare("UPDATE requests SET state = 'synced', completed_at = ?, last_error = NULL WHERE id = ?").run(this.clock(), id);
        this.logger?.info({ transactionId: id }, 'Transaction synchronized');
      } catch {
        const delay = Math.min(300000, this.retryMs * 2 ** Math.min(row.attempts, 16));
        this.db.prepare('UPDATE requests SET attempts = attempts + 1, next_attempt = ?, last_error = ? WHERE id = ?')
          .run(this.clock() + delay, 'delivery_failed', id);
        this.logger?.warn({ transactionId: id, attempts: row.attempts + 1 }, 'Transaction remains queued; delivery will be retried');
      }
    });
    // Never leave a rejected background promise unobserved, including disk errors.
    this.tail = operation.catch(() => { this.logger?.error('Outbox storage or delivery failed; inspect storage and service health'); });
    return this.tail;
  }

  async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      const rows = this.db.prepare("SELECT id FROM requests WHERE state = 'pending' AND next_attempt <= ? ORDER BY created_at LIMIT 20").all(this.clock());
      for (const row of rows) { if (this.closing) break; await this.attempt(row.id); }
      if (!this.closing) this.db.prepare("UPDATE requests SET payload = NULL WHERE state = 'synced' AND payload IS NOT NULL AND completed_at <= ?")
        .run(this.clock() - this.payloadDays * 86400000);
    } finally { this.ticking = false; }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    await this.tail;
    this.db.close();
  }
}

module.exports = { Outbox, hash };
