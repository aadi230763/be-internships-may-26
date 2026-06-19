/**
 * Sliding-window-log rate limiter.
 *
 * Instead of a fixed-window counter (which allows 2× bursts at boundaries),
 * we keep a sorted array of request timestamps per userId and prune expired
 * entries on each check.
 *
 * Concurrency safety (single instance):
 *   Node.js is single-threaded so `checkAndConsume` runs synchronously within
 *   one event-loop tick. No two calls can interleave the read-modify-write of
 *   the `buckets` Map, making it race-free in a single-process deployment.
 *
 * Multi-instance safety:
 *   In-memory state is process-local. For horizontal scale, replace this with
 *   a Redis-backed sliding window using a Lua script:
 *     MULTI
 *       ZREMRANGEBYSCORE key 0 (now - windowMs)   -- prune expired
 *       ZCARD key                                   -- count remaining
 *       ZADD key now member                         -- record this request
 *       PEXPIRE key windowMs                        -- TTL for cleanup
 *     EXEC
 *   This runs atomically on a single Redis node and works across instances.
 */

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/**
 * Map<userId, number[]>  – sorted arrays of request timestamps (epoch ms).
 */
const buckets = new Map();

/**
 * Check whether `userId` is within their rate limit and, if so, record the
 * request.  Returns { ok, remaining, resetMs }.
 *
 * @param {string} userId
 * @param {number} [nowMs=Date.now()]
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const windowStart = nowMs - WINDOW_MS;

  let timestamps = buckets.get(userId);
  if (!timestamps) {
    timestamps = [];
    buckets.set(userId, timestamps);
  }

  // Prune timestamps outside the current window.
  // Because the array is sorted ascending, we can binary-search or simply
  // shift from the front. For small RATE values a linear scan is fastest.
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  const ok = timestamps.length < RATE;

  if (ok) {
    timestamps.push(nowMs);
  }

  const remaining = Math.max(RATE - timestamps.length, 0);
  // resetMs = when the oldest request in the window will expire
  const resetMs = timestamps.length > 0 ? timestamps[0] + WINDOW_MS : nowMs + WINDOW_MS;

  return { ok, remaining, resetMs };
}

/**
 * Clear all rate-limit state (useful in tests).
 */
export function resetBuckets() {
  buckets.clear();
}

// Periodic cleanup of stale entries to prevent memory leaks from users
// who made requests but never returned.
const CLEANUP_INTERVAL_MS = 5 * 60_000; // every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  for (const [userId, timestamps] of buckets) {
    // If every timestamp is expired, remove the entire entry
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      buckets.delete(userId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Allow the process to exit even if the timer is still running
if (cleanupTimer.unref) cleanupTimer.unref();
