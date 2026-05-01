import './load-env.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { authRoutes } from './auth/routes.js';
import { clickupOauthRoutes } from './routes/clickup-oauth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { conversationRoutes } from './routes/conversations.js';
import { chatRoutes } from './routes/chat.js';
import { confirmWriteRoutes } from './routes/confirm-write.js';
import { undoRoutes } from './routes/undo.js';
import {
  getBoss,
  QUEUE_INITIAL_SYNC,
  QUEUE_SYNC_TASK,
  QUEUE_DRIFT,
  type InitialSyncPayload,
  type SyncTaskPayload,
  type DriftPayload,
} from './sync/boss.js';
import { runInitialSync } from './sync/initial-sync.js';
import { runSyncTask } from './sync/sync-task.js';
import { runDrift } from './sync/drift.js';

async function startWeb() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, role: 'web' }));
  app.route('/api/auth', authRoutes);
  app.route('/api/clickup', clickupOauthRoutes);
  app.route('/api/webhooks', webhookRoutes);
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/chat', chatRoutes);
  app.route('/api/confirm-write', confirmWriteRoutes);
  app.route('/api/undo', undoRoutes);
  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`[web] listening on http://localhost:${info.port}`);
  });
}

async function startWorker() {
  const boss = await getBoss();
  await boss.work<InitialSyncPayload>(QUEUE_INITIAL_SYNC, { batchSize: 1 }, async ([job]) => { await runInitialSync(job!.data); });
  await boss.work<SyncTaskPayload>(QUEUE_SYNC_TASK, { batchSize: 5 }, async (jobs) => { for (const j of jobs) await runSyncTask(j.data); });
  await boss.work<DriftPayload>(QUEUE_DRIFT, { batchSize: 1 }, async ([job]) => { await runDrift(job!.data); });
  await boss.schedule(QUEUE_DRIFT, '0 4 * * *', { workspaceId: 'ALL' }, { tz: 'UTC' });
  console.log('[worker] pg-boss workers registered');
  process.on('SIGTERM', async () => { await boss.stop({ graceful: true }); process.exit(0); });
}

if (env.PROCESS_ROLE === 'web') void startWeb();
else void startWorker();
