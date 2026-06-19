# Scale Plan — 10k RPS

## Data Model & Indexes

**Current (SQLite, single-instance)**
```sql
CREATE TABLE signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,       -- atomic dedup via INSERT OR IGNORE
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_user_created ON signals(user_id, created_at);
```

**At scale (PostgreSQL)**
- Replace `AUTOINCREMENT` with `BIGSERIAL` for efficient ID generation.
- `UNIQUE` constraint on `idempotency_key` → atomic upsert via `INSERT ... ON CONFLICT DO NOTHING`.
- Composite index `(user_id, created_at DESC)` covers the `GET /v1/signals` query (index-only scan).
- Partition `signals` table by `created_at` (monthly range partitions) for efficient writes and TTL-based cleanup.
- Connection pooling via `pgBouncer` (transaction mode, pool of ~50 connections shared across app instances).

---

## Idempotency Across Instances

**Current**: SQLite `UNIQUE` constraint + `INSERT OR IGNORE` — atomic and race-free within a single process.

**At scale**:
- Same pattern works with PostgreSQL: `INSERT INTO signals (...) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`.
- The DB-level unique constraint guarantees atomicity regardless of how many app instances are writing concurrently.
- **Alternative for higher throughput**: Use Redis as a fast idempotency cache:
  ```
  SET idempotency:{key} {signal_id} NX EX 86400   -- 24h TTL
  ```
  - If SET returns OK → proceed with insert.
  - If SET returns nil → key exists, return cached signal.
  - DB `UNIQUE` constraint remains as a safety net.

---

## Rate Limiting Across Instances

**Current**: In-memory sliding-window-log per process. Concurrency-safe within a single Node.js event loop, but not shared across instances.

**At scale — Redis sliding window with Lua script**:
```lua
-- Atomic Lua script on Redis
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1}  -- ok=true, remaining
else
  redis.call('PEXPIRE', key, window)
  return {0, 0}                   -- ok=false, remaining=0
end
```
- Runs atomically on a single Redis node → no races across app instances.
- Key per userId: `ratelimit:{userId}`.
- Sorted set timestamps auto-expire via `PEXPIRE`.
- For Redis HA: Redis Cluster with hash tags `{userId}` to ensure all ops for a user hit the same shard.

---

## Observability (Logs / Metrics / Alerts)

| Layer | Tool | What |
|-------|------|------|
| **Structured logging** | Pino (built into Fastify) | Request ID, userId, latency, status code, error context |
| **Metrics** | Prometheus + Grafana | `http_requests_total`, `http_request_duration_seconds`, `rate_limit_hits_total`, `db_retry_total`, `db_errors_total` |
| **Distributed tracing** | OpenTelemetry → Jaeger/Tempo | Trace spans across LB → app → DB |
| **Alerting** | Grafana Alerts / PagerDuty | P99 latency > 200ms, error rate > 1%, DB connection pool exhaustion |
| **Health checks** | `/healthz` endpoint | K8s liveness/readiness probes |

---

## Failure Modes

### DB Down
- **Retry with backoff**: Exponential backoff with jitter (current implementation: base 50ms, max 3 retries, ~0.8s worst case).
- **Circuit breaker**: After N consecutive failures (e.g., 5), open the circuit for 30s. Return 503 immediately instead of hammering the DB.
- **Graceful degradation**: Rate limiting continues to work (in-memory / Redis) even when the DB is down. Signals can be queued for later insertion.

### Partial Outages
- **Read replicas**: If primary is overloaded, route `GET /v1/signals` to read replicas (async replication, eventual consistency acceptable for reads).
- **Failover**: PostgreSQL with streaming replication + automatic failover (Patroni / RDS Multi-AZ).

### Retries
- **Idempotency-safe**: `INSERT ... ON CONFLICT DO NOTHING` makes all retries safe — no duplicates even if the insert is retried after a timeout where the first attempt actually succeeded.
- **Retry budget**: Cap total retries at 10% of throughput to prevent retry storms.

---

## 10k RPS Design Sketch

### Architecture
```
                         ┌──────────────┐
                         │   Clients    │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │  AWS ALB /   │
                         │  Nginx LB    │
                         └──────┬───────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
        │  App (N=4) │   │  App (N=4) │   │  App (N=4) │
        │  Node.js   │   │  Node.js   │   │  Node.js   │
        │  Fastify   │   │  Fastify   │   │  Fastify   │
        └─────┬──┬───┘   └─────┬──┬───┘   └─────┬──┬───┘
              │  │              │  │              │  │
              │  └──────┐       │  └──────┐       │  │
              │         │       │         │       │  │
        ┌─────▼─────┐  ┌▼──────▼─────────▼───────▼──▼─┐
        │ PostgreSQL │  │       Redis Cluster          │
        │  Primary   │  │  (rate limit + idem cache)   │
        │  + Replica │  └──────────────────────────────┘
        └────────────┘
```

### Capacity Planning

| Component | Spec | Rationale |
|-----------|------|-----------|
| **App instances** | 4× `c6i.large` (2 vCPU, 4 GB) | Fastify handles ~25k RPS on a single core with simple handlers. 4 instances give 4× headroom. |
| **Node.js cluster** | `cluster` module, 2 workers/instance | Utilize both vCPUs → 8 total workers across 4 instances. |
| **PostgreSQL** | `db.r6g.xlarge` (4 vCPU, 32 GB) RDS | Handles ~15k TPS for simple inserts with connection pooling. |
| **PgBouncer** | Transaction mode, pool_size=50 | Avoid connection exhaustion. 8 workers × 20 connections = 160 max, reduced to 50 by pooler. |
| **Redis** | `cache.r6g.large` (2 vCPU, 13 GB) ElastiCache | Rate limiting Lua scripts: ~100k ops/sec on single node. |
| **Load balancer** | AWS ALB | Distributes across app instances, health checks on `/healthz`. |

### Cost Estimate (AWS, us-east-1, monthly)

| Component | Monthly Cost |
|-----------|-------------|
| 4× `c6i.large` | ~$250 |
| RDS `db.r6g.xlarge` Multi-AZ | ~$550 |
| ElastiCache `cache.r6g.large` | ~$200 |
| ALB + data transfer | ~$100 |
| **Total** | **~$1,100/mo** |

### Write Path Optimization (if needed beyond 10k RPS)
- **Batch inserts**: Buffer incoming signals in-memory (or Redis list) for 50ms, then bulk `INSERT` in one transaction. Reduces DB round trips 10-50×.
- **Async queue**: Push signals to a message queue (SQS / Kafka) and write asynchronously with worker consumers. Return 202 Accepted immediately.
- **Sharding**: Shard the `signals` table by `user_id` hash across multiple PostgreSQL instances for horizontal write scaling.
