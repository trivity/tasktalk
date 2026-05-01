import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  listConversations, getConversation, createConversation,
  renameConversation, deleteConversation, listMessages,
} from '../db/queries/conversations.js';

const renameBody = z.object({ title: z.string().min(1).max(200) });

export const conversationRoutes = new Hono()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const u = c.get('user');
    const rows = await listConversations(u.id);
    return c.json({ conversations: rows });
  })
  .post('/', async (c) => {
    const u = c.get('user');
    const conv = await createConversation(u.id);
    return c.json({ conversation: conv });
  })
  .get('/:id', async (c) => {
    const u = c.get('user');
    const conv = await getConversation(u.id, c.req.param('id'));
    if (!conv) return c.json({ error: 'not_found' }, 404);
    return c.json({ conversation: conv });
  })
  .patch('/:id', zValidator('json', renameBody), async (c) => {
    const u = c.get('user');
    await renameConversation(u.id, c.req.param('id'), c.req.valid('json').title);
    return c.json({ ok: true });
  })
  .delete('/:id', async (c) => {
    const u = c.get('user');
    await deleteConversation(u.id, c.req.param('id'));
    return c.json({ ok: true });
  })
  .get('/:id/messages', async (c) => {
    const u = c.get('user');
    const msgs = await listMessages(u.id, c.req.param('id'));
    if (msgs === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ messages: msgs });
  });
