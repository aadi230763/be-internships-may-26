# Signals Challenge (Node.js + Fastify)

A minimal **production-leaning** signal ingestion service with robust rate limiting, atomic idempotency, and DB failure resilience.

## Quick Start

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

# 5. Benchmark
npm run bench
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | `change-me` | API key for `X-API-Key` header authentication |
| `PORT` | `8080` | Server port |
| `DATABASE_URL` | `./data/signals.db` | SQLite database file path |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per user per minute |
| `DB_FAIL_RATE` | `0` | Simulated DB failure rate (0–1) for testing retry logic |

## API Endpoints

### `GET /healthz`
Health check endpoint (no auth required).
```bash
curl http://localhost:8080/healthz
# {"ok":true}
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

**Headers:**
- `X-API-Key` (required) — API authentication
- `Idempotency-Key` (optional) — Prevents duplicate creation

**Rate limiting:** Each `userId` is limited to `RATE_LIMIT_PER_MIN` requests per minute. Returns `429` when exceeded.

### `GET /v1/signals?userId=...&limit=...`
List signals for a user (most recent first).
```bash
curl "http://localhost:8080/v1/signals?userId=user1&limit=10" \
  -H "X-API-Key: change-me"
```

## Architecture Decisions

### Rate Limiting — Sliding Window Log
- Uses sorted timestamp arrays per `userId` instead of fixed-window counters.
- Prevents the 2× burst problem at window boundaries.
- Concurrency-safe on single instance (Node.js single-threaded event loop).
- See [SCALE.md](SCALE.md) for multi-instance design with Redis.

### Atomic Idempotency — INSERT OR IGNORE
- Leverages SQLite's `UNIQUE` constraint on `idempotency_key`.
- `INSERT OR IGNORE` is a single atomic SQL statement — no check-then-insert race.
- If key exists: `changes === 0` → fetch and return existing row.
- If key is new: `changes === 1` → return the newly inserted row.

### DB Failure Handling — Retry with Backoff
- Exponential backoff with jitter: `base × 2^attempt × random(0.5, 1.0)`.
- Default: 3 retries, 50ms base delay.
- Retryable errors: `SQLITE_BUSY`, `simulated_db_failure`.
- Safe to retry because `INSERT OR IGNORE` is inherently idempotent.

### WAL Mode
- SQLite WAL (Write-Ahead Logging) enabled for better concurrent read performance.

## Project Structure
```
├── src/
│   ├── server.js      # Fastify app setup, auth hook, route registration
│   ├── signals.js     # POST/GET signal handlers with retry + idempotency
│   ├── rateLimit.js   # Sliding-window-log rate limiter
│   ├── retry.js       # Retry/backoff utility with jitter
│   └── db.js          # SQLite schema, queries, failure simulation
├── tests/
│   ├── idempotency.test.js   # Idempotency tests (concurrent, dedup)
│   ├── rate-limit.test.js    # Rate limit tests (burst, independence)
│   ├── db-retry.test.js      # DB failure recovery tests
│   └── api.test.js           # API integration tests (auth, validation)
├── data/                     # SQLite database files
├── SCALE.md                  # 10k RPS scale plan
└── package.json
```

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
node --test tests/idempotency.test.js

# Test with simulated DB failures
DB_FAIL_RATE=0.3 npm test
```

## Scale Plan

See [SCALE.md](SCALE.md) for the full 10k RPS design including:
- PostgreSQL migration with partitioning
- Redis-based distributed rate limiting (Lua script)
- Redis idempotency cache
- Architecture diagram with cost estimates
