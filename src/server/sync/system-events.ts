import postgres from 'postgres';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { messages } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

export type SystemEventPayload = {
  workspaceId: string;
  taskId: string;
  changeType: 'updated' | 'created' | 'deleted' | 'commented';
  taskName: string;
};

const NOTIFY_CHANNEL = 'tasktalk_system_events';

const notifier = postgres(env.DATABASE_URL, { max: 1 });

export async function broadcastSystemEvent(p: SystemEventPayload): Promise<void> {
  await notifier.notify(NOTIFY_CHANNEL, JSON.stringify(p));
}

const subscribers = new Map<string, Set<(p: SystemEventPayload) => void>>();
let listenStarted = false;

export async function subscribeForUserConversation(
  userId: string,
  conversationId: string,
  cb: (p: SystemEventPayload) => void,
): Promise<() => void> {
  await ensureListening();
  const key = `${userId}::${conversationId}`;
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(cb);
  return () => {
    subscribers.get(key)?.delete(cb);
    if (subscribers.get(key)?.size === 0) subscribers.delete(key);
  };
}

async function ensureListening(): Promise<void> {
  if (listenStarted) return;
  listenStarted = true;
  const listener = postgres(env.DATABASE_URL, { max: 1 });
  await listener.listen(NOTIFY_CHANNEL, async (payload) => {
    try {
      const p = JSON.parse(payload) as SystemEventPayload;
      await fanout(p);
    } catch {
      /* swallow */
    }
  });
}

async function fanout(p: SystemEventPayload): Promise<void> {
  // For each active subscriber, decide whether the event is relevant to that conversation.
  for (const [key, cbs] of subscribers) {
    const [userId, conversationId] = key.split('::');
    const relevant = await isRelevant({
      userId: userId!,
      conversationId: conversationId!,
      taskId: p.taskId,
      workspaceId: p.workspaceId,
    });
    if (!relevant) continue;
    // persist the system_event message
    await db.insert(messages).values({
      conversationId: conversationId!,
      role: 'system_event',
      content: {
        text: `Task "${p.taskName}" was ${p.changeType}`,
        taskId: p.taskId,
        changeType: p.changeType,
        taskName: p.taskName,
      },
    });
    for (const cb of cbs) cb(p);
  }
}

async function isRelevant(opts: {
  userId: string;
  conversationId: string;
  taskId: string;
  workspaceId: string;
}): Promise<boolean> {
  // (a) mentioned in last 20 messages of the conversation
  const recent = await db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, opts.conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(20);
  for (const m of recent) {
    const c = m.content as Record<string, unknown> | null;
    const blob = JSON.stringify(c ?? '');
    if (blob.includes(opts.taskId)) return true;
  }

  // (b) assigned to current user (we don't yet know mapping app-user → ClickUp member id;
  //     in MVP we skip this branch and rely on (a) and (c). Phase 2 introduces a mapping.)

  // (c) recently queried list contains this task — we don't model "recently queried" in MVP;
  //     skip and rely on (a).
  return false;
}
