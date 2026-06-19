/**
 * Retry utility with exponential backoff and jitter.
 *
 * Retries a synchronous or asynchronous function on transient DB errors.
 * Uses exponential backoff (base × 2^attempt) with random jitter to
 * prevent thundering-herd effects.
 *
 * Safe to use with idempotent DB operations (INSERT OR IGNORE).
 */

const RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const RETRYABLE_MESSAGES = ['simulated_db_failure'];

/**
 * Determine whether an error is transient and worth retrying.
 */
function isRetryable(err) {
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (RETRYABLE_MESSAGES.some((m) => err.message?.includes(m))) return true;
  return false;
}

/**
 * Execute `fn` with retry/backoff.
 *
 * @param {Function} fn          – The function to execute (sync or async).
 * @param {object}   [opts]
 * @param {number}   [opts.maxRetries=3]    – Maximum retry attempts.
 * @param {number}   [opts.baseDelayMs=50]  – Base delay before first retry.
 * @param {Function} [opts.logger]          – Optional logger ({ err, attempt }).
 * @returns {Promise<*>} Result of `fn`.
 */
export async function withRetry(fn, { maxRetries = 3, baseDelayMs = 50, logger } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }
      // Exponential backoff with full jitter: [0, base × 2^attempt)
      const cap = baseDelayMs * 2 ** attempt;
      const delay = Math.floor(cap * (0.5 + Math.random() * 0.5));
      if (logger) {
        logger({ err, attempt, nextDelayMs: delay });
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export { isRetryable };
