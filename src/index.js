/**
 * Signals Service Library Core
 *
 * Exports the core utilities for rate limiting, retry/backoff, and idempotent DB operations.
 * This allows integrating the robust backend logic into other Fastify/Express applications.
 *
 * @module SignalsCore
 */

import { checkAndConsume, resetBuckets } from './rateLimit.js';
import { withRetry, isRetryable } from './retry.js';
import { insertSignalAtomic, insertSignal, getByIdemKey, listSignals, closeDb } from './db.js';
import { buildApp } from './server.js';

export {
  // Rate Limiter
  checkAndConsume,
  resetBuckets,

  // Retry & Backoff
  withRetry,
  isRetryable,

  // Database Operations
  insertSignalAtomic,
  insertSignal,
  getByIdemKey,
  listSignals,
  closeDb,

  // Server Factory
  buildApp,
};
