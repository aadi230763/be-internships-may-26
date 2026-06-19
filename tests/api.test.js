import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

const PORT = 9094;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(PORT),
      DATABASE_URL: `./data/test-api-${Date.now()}.db`,
      RATE_LIMIT_PER_MIN: '100',
    },
  });
  return proc;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(chunks || '{}'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

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

test('GET /healthz returns ok', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const { statusCode, body } = await httpGet(`${BASE}/healthz`);
    assert.equal(statusCode, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    proc.kill();
  }
});

test('POST /v1/signals without API key returns 401', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const { statusCode, body } = await postJson(`${BASE}/v1/signals`, {
      headers: {}, // no x-api-key
      body: { userId: 'u1', type: 'note', payload: 'test' },
    });
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthorized');
  } finally {
    proc.kill();
  }
});

test('POST /v1/signals with invalid body returns 400', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const { statusCode, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u1' }, // missing type and payload
    });
    assert.equal(statusCode, 400);
    assert.equal(body.error, 'invalid_body');
  } finally {
    proc.kill();
  }
});

test('GET /v1/signals returns signals for user', async () => {
  const proc = startServer();
  await wait(500);

  try {
    // Create some signals first
    for (let i = 0; i < 3; i++) {
      await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'list-user', type: 'note', payload: `item-${i}` },
      });
    }

    // Query them
    const { statusCode, body } = await httpGet(
      `${BASE}/v1/signals?userId=list-user&limit=10`,
      { 'x-api-key': 'k' }
    );

    assert.equal(statusCode, 200);
    assert.ok(Array.isArray(body.items), 'items should be an array');
    assert.equal(body.items.length, 3, 'Should have 3 signals');
    assert.equal(body.items[0].userId, 'list-user');
  } finally {
    proc.kill();
  }
});

test('GET /v1/signals without userId returns 400', async () => {
  const proc = startServer();
  await wait(500);

  try {
    const { statusCode, body } = await httpGet(`${BASE}/v1/signals`, { 'x-api-key': 'k' });
    assert.equal(statusCode, 400);
    assert.equal(body.error, 'missing_userId');
  } finally {
    proc.kill();
  }
});

test('GET /v1/signals respects limit parameter', async () => {
  const proc = startServer();
  await wait(500);

  try {
    // Create 5 signals
    for (let i = 0; i < 5; i++) {
      await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'limit-user', type: 'note', payload: `item-${i}` },
      });
    }

    // Query with limit=2
    const { statusCode, body } = await httpGet(
      `${BASE}/v1/signals?userId=limit-user&limit=2`,
      { 'x-api-key': 'k' }
    );

    assert.equal(statusCode, 200);
    assert.equal(body.items.length, 2, 'Should only return 2 items');
  } finally {
    proc.kill();
  }
});
