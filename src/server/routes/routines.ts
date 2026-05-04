import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { routines, routineRuns, conversations } from '../db/schema.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware.js';
import { computeNextRun, describeSchedule, validateSchedule } from '../routines/schedule-utils.js';
import { executeRoutine } from '../routines/executor.js';
import { getNumericSetting, APP_SETTING_KEYS, DEFAULTS } from '../settings/app-settings.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2000),
  schedule: z.unknown(),
  timezone: z.string().min(1).max(60),
  deliverChat: z.boolean().default(true),
  deliverEmail: z.boolean().default(false),
  emailTo: z.string().email().nullable().optional(),
  enabled: z.boolean().default(true),
});

const patchSchema = createSchema.partial();

export const routinesRoutes = new Hono()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const u = c.get('user');
    const rows = await db.select().from(routines).where(eq(routines.userId, u.id)).orderBy(desc(routines.updatedAt));
    // Latest run per routine
    const runRows = rows.length > 0
      ? await db
          .select()
          .from(routineRuns)
          .where(sql`${routineRuns.routineId} = ANY(${rows.map((r) => r.id)})`)
          .orderBy(desc(routineRuns.startedAt))
      : [];
    const lastRunByRoutine = new Map<string, typeof runRows[number]>();
    for (const r of runRows) {
      if (!lastRunByRoutine.has(r.routineId)) lastRunByRoutine.set(r.routineId, r);
    }
    return c.json({
      routines: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        schedule: r.schedule,
        scheduleDescription: describeSchedule(r.schedule, r.timezone),
        timezone: r.timezone,
        deliverChat: r.deliverChat,
        deliverEmail: r.deliverEmail,
        emailTo: r.emailTo,
        enabled: r.enabled,
        conversationId: r.conversationId,
        lastRunAt: r.lastRunAt,
        nextRunAt: r.nextRunAt,
        lastRun: lastRunByRoutine.get(r.id)
          ? {
              status: lastRunByRoutine.get(r.id)!.status,
              startedAt: lastRunByRoutine.get(r.id)!.startedAt,
              finishedAt: lastRunByRoutine.get(r.id)!.finishedAt,
              errorMessage: lastRunByRoutine.get(r.id)!.errorMessage,
            }
          : null,
      })),
    });
  })
  .post('/', async (c) => {
    const u = c.get('user');
    const body = createSchema.parse(await c.req.json());
    const schedule = validateSchedule(body.schedule);
    if (!schedule) return c.json({ error: 'invalid_schedule' }, 400);

    // Enforce per-user cap
    const cap = await getNumericSetting(APP_SETTING_KEYS.routinesPerUserCap, DEFAULTS.routinesPerUserCap);
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(routines)
      .where(eq(routines.userId, u.id));
    const currentCount = countRows[0]?.count ?? 0;
    if (currentCount >= cap) {
      return c.json({ error: 'routine_cap_reached', cap }, 400);
    }

    // Pinned conversation for this routine
    const [conv] = await db
      .insert(conversations)
      .values({ userId: u.id, title: `🔁 ${body.name}` })
      .returning();

    const next = computeNextRun(schedule, body.timezone);
    const [routine] = await db
      .insert(routines)
      .values({
        userId: u.id,
        name: body.name,
        prompt: body.prompt,
        schedule,
        timezone: body.timezone,
        deliverChat: body.deliverChat,
        deliverEmail: body.deliverEmail,
        emailTo: body.emailTo ?? null,
        enabled: body.enabled,
        conversationId: conv!.id,
        nextRunAt: next,
      })
      .returning();
    return c.json({ routine });
  })
  .patch('/:id', async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const body = patchSchema.parse(await c.req.json());

    const [existing] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.userId, u.id)))
      .limit(1);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.deliverChat !== undefined) updates.deliverChat = body.deliverChat;
    if (body.deliverEmail !== undefined) updates.deliverEmail = body.deliverEmail;
    if (body.emailTo !== undefined) updates.emailTo = body.emailTo ?? null;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.schedule !== undefined) {
      const sched = validateSchedule(body.schedule);
      if (!sched) return c.json({ error: 'invalid_schedule' }, 400);
      updates.schedule = sched;
      const tz = body.timezone ?? existing.timezone;
      updates.nextRunAt = computeNextRun(sched, tz);
    } else if (body.timezone !== undefined) {
      updates.nextRunAt = computeNextRun(existing.schedule, body.timezone);
    }
    await db.update(routines).set(updates).where(eq(routines.id, id));
    return c.json({ ok: true });
  })
  .delete('/:id', async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    await db.delete(routines).where(and(eq(routines.id, id), eq(routines.userId, u.id)));
    return c.json({ ok: true });
  })
  .post('/:id/run-now', async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const [existing] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.userId, u.id)))
      .limit(1);
    if (!existing) return c.json({ error: 'not_found' }, 404);
    // Run inline so the user sees a definitive result.
    try {
      await executeRoutine(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String((err as Error).message ?? err) }, 500);
    }
  });
