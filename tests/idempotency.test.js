import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

const PORT = 9091;
const BASE = `http://localhost:${PORT}`;

/**
 * Spawns the server in a child process for integration testing.
 * Uses a unique DATABASE_URL so tests don't collide with each other.
 */
function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(PORT),
      DATABASE_URL: `./data/test-idem-${Date.now()}.db`,
      RATE_LIMIT_PER_MIN: '100', // high limit so rate limiting doesn't interfere
    },
  });
  return proc;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => resolve(JSON.parse(chunks || '{}')));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test('idempotency: returns same resource for same key', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const idem = `idem-same-${Date.now()}`;
    const body = { userId: 'u1', type: 'note', payload: 'x' };
    const headers = { 'x-api-key': 'k', 'Idempotency-Key': idem };

    const a = await postJson(`${BASE}/v1/signals`, { headers, body });
    const b = await postJson(`${BASE}/v1/signals`, { headers, body });

    assert.equal(a.id, b.id, 'Should return the same id');
    assert.equal(a.idempotencyKey, b.idempotencyKey, 'Should return the same idempotency key');
    assert.equal(a.createdAt, b.createdAt, 'Should return the same createdAt');
  } finally {
    proc.kill();
  }
});

test('idempotency: different keys create different signals', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const body = { userId: 'u1', type: 'note', payload: 'y' };

    const a = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': `key-a-${Date.now()}` },
      body,
    });
    const b = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': `key-b-${Date.now()}` },
      body,
    });

    assert.notEqual(a.id, b.id, 'Different keys should create different rows');
  } finally {
    proc.kill();
  }
});

test('idempotency: no key allows duplicates', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const body = { userId: 'u1', type: 'note', payload: 'dup' };
    const headers = { 'x-api-key': 'k' }; // no Idempotency-Key

    const a = await postJson(`${BASE}/v1/signals`, { headers, body });
    const b = await postJson(`${BASE}/v1/signals`, { headers, body });

    assert.notEqual(a.id, b.id, 'Without key, duplicates should be created');
  } finally {
    proc.kill();
  }
});

test('idempotency: concurrent requests with same key create only one row', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const idem = `concurrent-${Date.now()}`;
    const body = { userId: 'u1', type: 'note', payload: 'concurrent' };
    const headers = { 'x-api-key': 'k', 'Idempotency-Key': idem };

    // Fire 10 requests in parallel with the same idempotency key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postJson(`${BASE}/v1/signals`, { headers, body }))
    );

    // All should return the same id
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 1, `Expected 1 unique id but got ${ids.size}: ${[...ids]}`);
  } finally {
    proc.kill();
  }
});
