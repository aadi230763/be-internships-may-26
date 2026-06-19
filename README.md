TASKS IMPELEMENTED : 


<img width="662" height="397" alt="image" src="https://github.com/user-attachments/assets/f94331f7-45f8-449a-bc90-9bb128c04a14" />















# Signals Challenge (Node.js + Fastify)

![Tests](https://img.shields.io/badge/Tests-16%2F16_Passing-brightgreen?style=for-the-badge)
![Code Style](https://img.shields.io/badge/Code_Style-Prettier%20%2B%20ESLint-ff69b4?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)
![Architecture](https://img.shields.io/badge/Architecture-10k_RPS_Ready-orange?style=for-the-badge)

A minimal **production-leaning** signal ingestion library and service with robust rate limiting, atomic idempotency, and DB failure resilience.

---

## ⚡ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment config
cp .env.example .env

# 3. Start the server
npm run dev
# Server runs on http://localhost:8080

# 4. Run tests
npm test

# 5. Lint & Format
npm run lint
npm run fmt
```

---

## 📦 Library Usage

The core utilities are exported from `src/index.js` and can be used programmatically:

```js
import {
  checkAndConsume, // Sliding-window rate limiter
  withRetry, // Exponential backoff with jitter
  buildApp, // Fastify server factory
} from './src/index.js';

// ── Rate Limiting ──────────────────────────────────────
const { ok, remaining, resetMs } = checkAndConsume('user-123');
if (!ok) {
  console.log(`Rate limited. Retry after ${new Date(resetMs).toISOString()}`);
}

// ── Retry with Backoff ─────────────────────────────────
const result = await withRetry(() => someFlakyDbCall(), { maxRetries: 3, baseDelayMs: 50 });

// ── Programmatic Server ────────────────────────────────
const app = buildApp({ logger: { level: 'info' } });
await app.listen({ port: 3000 });
```

---

## 🔧 Environment Variables

| Variable             | Default             | Description                                             |
| -------------------- | ------------------- | ------------------------------------------------------- |
| `API_KEY`            | `change-me`         | API key for `X-API-Key` header authentication           |
| `PORT`               | `8080`              | Server port                                             |
| `DATABASE_URL`       | `./data/signals.db` | SQLite database file path                               |
| `RATE_LIMIT_PER_MIN` | `5`                 | Max requests per user per minute                        |
| `DB_FAIL_RATE`       | `0`                 | Simulated DB failure rate (0–1) for testing retry logic |

---

## 🌐 API Endpoints

### `GET /healthz`

Health check endpoint (no auth required).

```bash
curl http://localhost:8080/healthz
# → {"ok":true}
```

### `POST /v1/signals`

Create a new signal.

```bash
curl -X POST http://localhost:8080/v1/signals \
  -H "Content-Type: application/json" \
  -H "X-API-Key: change-me" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{"userId":"user1","type":"click","payload":"button-signup"}'
```

| Header            | Required | Description                        |
| ----------------- | -------- | ---------------------------------- |
| `X-API-Key`       | ✅       | API authentication                 |
| `Idempotency-Key` | ❌       | Prevents duplicate signal creation |

**Rate limiting:** Each `userId` is limited to `RATE_LIMIT_PER_MIN` requests per minute.
A `429` response is returned when the limit is exceeded, with `remaining` and `resetMs` in the body.

### `GET /v1/signals?userId=...&limit=...`

List signals for a user (most recent first, max 100).

```bash
curl "http://localhost:8080/v1/signals?userId=user1&limit=10" \
  -H "X-API-Key: change-me"
# → {"items":[{"id":1,"userId":"user1","type":"click",...}]}
```

---

## 🏛 Architecture Decisions

### 1. Rate Limiting — Sliding Window Log

| Aspect                    | Detail                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| **Algorithm**             | Sorted timestamp array per `userId`, pruned on each request              |
| **Why not fixed-window?** | Fixed-window counters allow 2× burst at boundaries                       |
| **Concurrency safety**    | Synchronous within a single Node.js event-loop tick — no races           |
| **Multi-instance**        | Replace with Redis `ZRANGEBYSCORE` Lua script (see [SCALE.md](SCALE.md)) |

### 2. Atomic Idempotency — INSERT OR IGNORE

```
Request arrives with Idempotency-Key
         │
         ▼
┌─────────────────────────┐
│  INSERT OR IGNORE INTO  │  ← single atomic SQL statement
│  signals (... idem_key) │     leverages UNIQUE constraint
└──────────┬──────────────┘
           │
     ┌─────┴─────┐
     │            │
 changes=1    changes=0
 (new row)    (exists)
     │            │
     ▼            ▼
  Return       SELECT by
  new row      idem_key
               → return
               existing row
```

- **No check-then-insert race** — the constraint check and insert happen in a single statement.
- Safe to retry because `INSERT OR IGNORE` is inherently idempotent.

### 3. DB Failure Handling — Retry with Exponential Backoff

```
Attempt 0 ──fail──▶ wait ~50ms
Attempt 1 ──fail──▶ wait ~100ms (+ jitter)
Attempt 2 ──fail──▶ wait ~200ms (+ jitter)
Attempt 3 ──fail──▶ throw (503 to client)
```

- **Jitter**: `delay = base × 2^attempt × random(0.5, 1.0)` — prevents thundering herd.
- **Retryable errors**: `SQLITE_BUSY`, `simulated_db_failure`.
- Combined with idempotent inserts, retries never create duplicates.

### 4. WAL Mode

SQLite WAL (Write-Ahead Logging) is enabled for concurrent read performance, allowing readers and writers to operate simultaneously without blocking.

---

## 📁 Project Structure

```
signals-challenge-node/
├── src/
│   ├── index.js       # Library entrypoint — exports core utilities
│   ├── server.js      # Fastify app factory + auth hook + route registration
│   ├── signals.js     # POST/GET handlers with atomic idempotency + retry
│   ├── rateLimit.js   # Sliding-window-log rate limiter
│   ├── retry.js       # Retry/backoff utility with exponential jitter
│   └── db.js          # SQLite schema, queries, WAL mode, failure simulation
├── tests/
│   ├── api.test.js           # API integration (auth, validation, CRUD)
│   ├── idempotency.test.js   # Idempotency (dedup, concurrent burst)
│   ├── rate-limit.test.js    # Rate limiting (burst, independence)
│   └── db-retry.test.js      # DB failure recovery under load
├── .env.example              # Environment variable template
├── .eslintrc / .prettierrc   # Code quality configuration
├── SCALE.md                  # 10k RPS scale plan
├── README.md
└── package.json
```

---

## 🧪 Testing

```bash
# Run all 16 tests
npm test

# Run a specific test suite
node --test tests/idempotency.test.js
node --test tests/rate-limit.test.js
node --test tests/db-retry.test.js
node --test tests/api.test.js

# Test with simulated DB failures (30% failure rate)
DB_FAIL_RATE=0.3 npm test
```

### Test Coverage Matrix

| Suite           | Tests | What it verifies                                                                       |
| --------------- | ----- | -------------------------------------------------------------------------------------- |
| **API**         | 6     | healthz, auth 401, body validation 400, GET signals, limit param                       |
| **Idempotency** | 4     | Same key → same row, different keys, no key → dups ok, **10-request concurrent burst** |
| **Rate Limit**  | 4     | 5/min cap, independent user limits, **10-request parallel burst**, 429 response body   |
| **DB Retry**    | 2     | Recovery under 30% fail rate, no duplicates during retries                             |

---

## 🚀 Scale Plan

See **[SCALE.md](SCALE.md)** for the full 10k RPS design including:

- 📊 PostgreSQL migration with range partitioning
- 🔒 Redis-based distributed rate limiting (atomic Lua script)
- 🗄️ Redis idempotency cache with DB fallback
- 📈 Observability (Pino → Prometheus → Grafana → PagerDuty)
- 🏗️ Architecture diagram (ALB → 4× Node.js → PG + Redis)
- 💰 AWS cost estimate: ~$1,100/mo
