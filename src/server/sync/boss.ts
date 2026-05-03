import PgBoss from 'pg-boss';
import { env } from '../env.js';

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => console.error('[boss] error', e));
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}

export const QUEUE_INITIAL_SYNC = 'initial-sync';
export const QUEUE_SYNC_TASK = 'sync-task';
export const QUEUE_DRIFT = 'drift-reconcile';
export const QUEUE_TOMBSTONE_PURGE = 'tombstone-purge';

export type InitialSyncPayload = { userId: string; workspaceId?: string };
export type SyncTaskPayload = { workspaceId: string; taskId: string };
export type DriftPayload = { workspaceId: string };
