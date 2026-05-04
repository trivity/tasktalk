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
import { onboardingRoutes } from './routes/onboarding.js';
import { aiCredentialsRoutes } from './routes/ai-credentials.js';
import { adminRoutes } from './routes/admin.js';
import { routinesRoutes } from './routes/routines.js';
import {
  getBoss,
  QUEUE_INITIAL_SYNC,
  QUEUE_SYNC_TASK,
  QUEUE_DRIFT,
  QUEUE_TOMBSTONE_PURGE,
  type InitialSyncPayload,
  type SyncTaskPayload,
  type DriftPayload,
} from './sync/boss.js';
import { runInitialSync } from './sync/initial-sync.js';
import { runSyncTask } from './sync/sync-task.js';
import { runDrift } from './sync/drift.js';
import { runTombstonePurge } from './sync/tombstone-purge.js';
import { registerRoutines } from './routines/scheduler.js';

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
  app.route('/api/onboarding', onboardingRoutes);
  app.route('/api/auth/me/ai-credentials', aiCredentialsRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/routines', routinesRoutes);
  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`[web] listening on http://localhost:${info.port}`);
  });

  // Register routine scheduler in-process for dev. In a true split-process
  // deployment the worker registers it instead; pg-boss handles dedup.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const boss = await getBoss();
      await registerRoutines(boss);
    } catch (e) {
      console.error('[routines] failed to register scheduler in web', e);
    }
  }
}

async function startWorker() {
  const boss = await getBoss();
  await boss.work<InitialSyncPayload>(QUEUE_INITIAL_SYNC, { batchSize: 1 }, async ([job]) => { await runInitialSync(job!.data); });
  await boss.work<SyncTaskPayload>(QUEUE_SYNC_TASK, { batchSize: 5 }, async (jobs) => { for (const j of jobs) await runSyncTask(j.data); });
  await boss.work<DriftPayload>(QUEUE_DRIFT, { batchSize: 1 }, async ([job]) => { await runDrift(job!.data); });
  await boss.schedule(QUEUE_DRIFT, '0 4 * * *', { workspaceId: 'ALL' }, { tz: 'UTC' });
  await boss.work(QUEUE_TOMBSTONE_PURGE, { batchSize: 1 }, async () => { await runTombstonePurge(); });
  await boss.schedule(QUEUE_TOMBSTONE_PURGE, '0 5 * * *', {}, { tz: 'UTC' });
  await registerRoutines(boss);
  console.log('[worker] pg-boss workers registered');
  process.on('SIGTERM', async () => { await boss.stop({ graceful: true }); process.exit(0); });
}

if (env.PROCESS_ROLE === 'web') void startWeb();
else void startWorker();
