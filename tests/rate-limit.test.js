import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

const PORT = 9092;
const BASE = `http://localhost:${PORT}`;
const RATE = 5;

/**
 * Spawns the server in a child process for integration testing.
 */
function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(PORT),
      DATABASE_URL: `./data/test-rate-${Date.now()}.db`,
      RATE_LIMIT_PER_MIN: String(RATE),
    },
  });
  return proc;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postStatus(url, { headers, body }) {
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
            headers: res.headers,
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

test('rate limit: allow 5 per minute, 6th is 429', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { statusCode } = await postStatus(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u1', type: 'note', payload: String(i) },
      });
      statuses.push(statusCode);
    }

    const counts = statuses.reduce((acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc), {});
    assert.equal(counts[200], 5, `Expected 5 successes, got ${counts[200]}`);
    assert.ok(counts[429] >= 1, 'Expected at least one 429');
  } finally {
    proc.kill();
  }
});

test('rate limit: different users have independent limits', async () => {
  const proc = startServer();
  await wait(500);

  try {
    // Exhaust user1's limit
    for (let i = 0; i < RATE; i++) {
      await postStatus(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'user1', type: 'note', payload: String(i) },
      });
    }

    // user2 should still be able to make requests
    const { statusCode } = await postStatus(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'user2', type: 'note', payload: 'ok' },
    });

    assert.equal(statusCode, 200, 'user2 should not be rate limited');
  } finally {
    proc.kill();
  }
});

test('rate limit: concurrent burst respects limit', async () => {
  const proc = startServer();
  await wait(500);

  try {
    // Fire 10 requests in parallel for same user
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postStatus(`${BASE}/v1/signals`, {
          headers: { 'x-api-key': 'k' },
          body: { userId: 'burst-user', type: 'note', payload: String(i) },
        })
      )
    );

    const codes = results.map((r) => r.statusCode);
    const successes = codes.filter((c) => c === 200).length;
    const limited = codes.filter((c) => c === 429).length;

    assert.equal(successes, RATE, `Expected exactly ${RATE} successes, got ${successes}`);
    assert.equal(limited, 10 - RATE, `Expected ${10 - RATE} rate-limited, got ${limited}`);
  } finally {
    proc.kill();
  }
});

test('rate limit: 429 response contains rate limit info', async () => {
  const proc = startServer();
  await wait(500);

  try {
    // Exhaust the limit
    for (let i = 0; i < RATE; i++) {
      await postStatus(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'header-user', type: 'note', payload: String(i) },
      });
    }

    // This should be 429
    const { statusCode, body } = await postStatus(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'header-user', type: 'note', payload: 'blocked' },
    });

    assert.equal(statusCode, 429);
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.remaining, 0);
    assert.ok(body.resetMs > 0, 'Should contain resetMs');
  } finally {
    proc.kill();
  }
});
