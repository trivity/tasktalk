import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { getBoss, QUEUE_SYNC_TASK } from '../sync/boss.js';

function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', env.CLICKUP_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const webhookRoutes = new Hono()
  .post('/clickup', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-signature');
    if (!verifySignature(raw, sig)) return c.json({ error: 'bad_signature' }, 401);

    const body = JSON.parse(raw) as { event?: string; task_id?: string; team_id?: string };
    if (!body.task_id || !body.team_id) return c.json({ ok: true });

    const boss = await getBoss();
    // dedup by job id within a 1s window — pg-boss singleton pattern
    await boss.send(
      QUEUE_SYNC_TASK,
      { workspaceId: body.team_id, taskId: body.task_id },
      { singletonKey: `${body.team_id}:${body.task_id}`, singletonSeconds: 1 },
    );
    return c.json({ ok: true });
  });
