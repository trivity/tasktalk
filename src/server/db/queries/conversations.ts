import { db } from '../client.js';
import { conversations, messages } from '../schema.js';
import { and, eq, desc } from 'drizzle-orm';

export async function listConversations(userId: string) {
  return await db.select().from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt));
}

export async function getConversation(userId: string, id: string) {
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId))).limit(1);
  return row ?? null;
}

export async function createConversation(userId: string, title = 'New conversation') {
  const [row] = await db.insert(conversations).values({ userId, title }).returning();
  return row!;
}

export async function renameConversation(userId: string, id: string, title: string) {
  await db.update(conversations).set({ title })
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

export async function deleteConversation(userId: string, id: string) {
  await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

export async function listMessages(userId: string, conversationId: string) {
  // verify conv ownership first
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  return await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

export async function bumpLastMessageAt(conversationId: string) {
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
}
