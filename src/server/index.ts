import './load-env.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';

async function startWeb() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, role: 'web' }));
  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`[web] listening on http://localhost:${info.port}`);
  });
}

async function startWorker() {
  console.log('[worker] starting (no jobs registered yet)');
  process.stdin.resume();
}

if (env.PROCESS_ROLE === 'web') void startWeb();
else void startWorker();
