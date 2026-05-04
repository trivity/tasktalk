import type PgBoss from 'pg-boss';
import { db } from '../db/client.js';
import { routines } from '../db/schema.js';
import { and, eq, lte } from 'drizzle-orm';
import { computeNextRun } from './schedule-utils.js';
import { executeRoutine } from './executor.js';
import { QUEUE_ROUTINES_RUN, QUEUE_ROUTINES_TICK, type RoutinesRunPayload } from '../sync/boss.js';

/**
 * Register the routine-tick scheduler and the routine-run worker on the given
 * pg-boss instance. Safe to call from web or worker process.
 */
export async function registerRoutines(boss: PgBoss): Promise<void> {
  // pg-boss v10 requires queues to be created before scheduling work on them.
  // createQueue is idempotent.
  await boss.createQueue(QUEUE_ROUTINES_RUN);
  await boss.createQueue(QUEUE_ROUTINES_TICK);

  // Worker that actually runs a routine.
  await boss.work<RoutinesRunPayload>(QUEUE_ROUTINES_RUN, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await executeRoutine(job.data.routineId);
  });

  // Tick worker: scans for due routines and dispatches them.
  await boss.work(QUEUE_ROUTINES_TICK, { batchSize: 1 }, async () => {
    await dispatchDueRoutines(boss);
  });

  // Schedule the tick every minute.
  await boss.schedule(QUEUE_ROUTINES_TICK, '* * * * *', {}, { tz: 'UTC' });
  console.log('[routines] scheduler registered (tick every minute)');
}

/**
 * Find every enabled routine whose next_run_at has passed, advance their
 * next_run_at to a future time, and dispatch them to the run queue.
 *
 * Advancing next_run_at *before* the worker runs prevents double-dispatch on
 * the next minute tick if the run takes longer than one minute. The actual
 * `last_run_at` is set inside executeRoutine after the run finishes.
 */
async function dispatchDueRoutines(boss: PgBoss): Promise<void> {
  const now = new Date();
  const due = await db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)));

  for (const r of due) {
    const next = computeNextRun(r.schedule, r.timezone, now);
    await db.update(routines).set({ nextRunAt: next }).where(eq(routines.id, r.id));
    await boss.send(QUEUE_ROUTINES_RUN, { routineId: r.id });
  }
}
