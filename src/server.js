import Fastify from 'fastify';
import dotenv from 'dotenv';
import { postSignal, getSignals } from './signals.js';

dotenv.config();
const API_KEY = process.env.API_KEY || 'change-me';
const PORT = Number(process.env.PORT || 8080);

/**
 * Build a configured Fastify application.
 *
 * Exported so tests can create isolated instances without spawning
 * child processes — faster, more reliable, and deterministic.
 *
 * @param {object} [opts] – Fastify constructor options.
 * @returns {import('fastify').FastifyInstance}
 */
export function buildApp(opts = {}) {
  const app = Fastify({ logger: { level: 'warn' }, ...opts });

  // API key authentication hook (skip /healthz)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.post('/v1/signals', postSignal);
  app.get('/v1/signals', getSignals);

  return app;
}

// Auto-start when run directly (not when imported by tests)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/server.js') || process.argv[1].endsWith('\\server.js'));

if (isDirectRun) {
  const app = buildApp({ logger: { level: 'info' } });
  app.listen({ host: '0.0.0.0', port: PORT }).catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
}
