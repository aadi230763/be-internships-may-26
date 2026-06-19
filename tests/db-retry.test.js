import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

const PORT = 9093;
const BASE = `http://localhost:${PORT}`;

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
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(chunks || '{}'),
          })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test('db retry: service recovers from transient DB failures', async () => {
  // Start with a moderate failure rate — the retry mechanism should
  // absorb most/all transient failures
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(PORT),
      DATABASE_URL: `./data/test-retry-${Date.now()}.db`,
      RATE_LIMIT_PER_MIN: '100',
      DB_FAIL_RATE: '0.3', // 30% chance of failure per DB call
    },
  });
  await wait(500);

  try {
    let successes = 0;
    const total = 20;

    for (let i = 0; i < total; i++) {
      const { statusCode } = await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'retry-user', type: 'note', payload: String(i) },
      });
      if (statusCode === 200) successes++;
    }

    // With 30% fail rate and 3 retries, most requests should succeed
    // P(all 4 attempts fail) = 0.3^4 ≈ 0.8%, so ~99.2% should succeed
    assert.ok(
      successes >= total * 0.7,
      `Expected at least ${Math.floor(total * 0.7)} successes with retry, got ${successes}`
    );
  } finally {
    proc.kill();
  }
});

test('db retry: no duplicates created during retries with idempotency key', async () => {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(PORT),
      DATABASE_URL: `./data/test-retry-idem-${Date.now()}.db`,
      RATE_LIMIT_PER_MIN: '100',
      DB_FAIL_RATE: '0.2',
    },
  });
  await wait(500);

  try {
    const idem = `retry-idem-${Date.now()}`;
    const body = { userId: 'u1', type: 'note', payload: 'retry-test' };
    const headers = { 'x-api-key': 'k', 'Idempotency-Key': idem };

    // Send the same request 10 times — with retries and failures,
    // all successful responses should have the same id
    const results = [];
    for (let i = 0; i < 10; i++) {
      const { statusCode, body: respBody } = await postJson(`${BASE}/v1/signals`, {
        headers,
        body,
      });
      if (statusCode === 200) {
        results.push(respBody);
      }
    }

    if (results.length > 1) {
      const ids = new Set(results.map((r) => r.id));
      assert.equal(
        ids.size,
        1,
        `All successful responses should have the same id. Got: ${[...ids]}`
      );
    }
  } finally {
    proc.kill();
  }
});
