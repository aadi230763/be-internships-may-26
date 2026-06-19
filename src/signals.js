import { insertSignalAtomic, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';
import { withRetry } from './retry.js';

function nowMs() {
  return Date.now();
}

/**
 * POST /v1/signals
 *
 * Creates a new signal with rate limiting and idempotency support.
 *
 * Idempotency strategy:
 *   Uses INSERT OR IGNORE with the UNIQUE constraint on idempotency_key.
 *   - If changes === 1 → new row inserted, return it.
 *   - If changes === 0 → duplicate key, fetch and return existing row.
 *   This is a single atomic SQL statement — no check-then-insert race.
 *
 * DB failure handling:
 *   All DB operations are wrapped in withRetry() which provides exponential
 *   backoff with jitter. Because INSERT OR IGNORE is idempotent by nature,
 *   retrying the same insert is safe.
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  // Validate body
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // Rate-limit check (synchronous, no DB call)
  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) {
    reply.header('X-RateLimit-Remaining', '0');
    reply.header('X-RateLimit-Reset', String(resetMs));
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  try {
    // If idempotency key provided, use atomic upsert pattern
    if (idem) {
      const result = await withRetry(
        () => {
          const t = nowMs();
          const info = insertSignalAtomic(userId, type, payload, idem, t);

          if (info.changes === 0) {
            // Row already existed — fetch and return the original
            const existing = getByIdemKey(idem);
            if (existing) return { created: false, data: existing };
            // Edge case: shouldn't happen if constraints are correct
            throw new Error('idempotency_key_conflict');
          }

          // Freshly inserted
          return {
            created: true,
            data: {
              id: Number(info.lastInsertRowid),
              userId,
              type,
              payload: String(payload),
              idempotencyKey: idem,
              createdAt: t,
            },
          };
        },
        { logger: (info) => req.log.warn({ ...info, ctx: 'insertSignalAtomic' }) }
      );

      return result.data;
    }

    // No idempotency key — normal insert with retry
    const data = await withRetry(
      () => {
        const t = nowMs();
        const info = insertSignalAtomic(userId, type, payload, null, t);
        return {
          id: Number(info.lastInsertRowid),
          userId,
          type,
          payload: String(payload),
          idempotencyKey: null,
          createdAt: t,
        };
      },
      { logger: (info) => req.log.warn({ ...info, ctx: 'insertSignal' }) }
    );

    return data;
  } catch (e) {
    req.log.error({ err: e, ctx: 'postSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/**
 * GET /v1/signals?userId=...&limit=...
 *
 * Lists signals for a given userId, most recent first.
 */
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);

  try {
    const rows = await withRetry(() => listSignals(userId, lim), {
      logger: (info) => req.log.warn({ ...info, ctx: 'listSignals' }),
    });
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'getSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
