import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { userAiCredentials } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { encryptToken } from '../db/encrypt.js';
import { env } from '../env.js';
import { ANTHROPIC_MODELS, DEFAULT_MODEL } from '../claude/get-client.js';

const setBody = z.object({
  provider: z.enum(['anthropic']),
  api_key: z.string().min(8).max(500),
  model_preference: z.string().optional(),
});

const PROVIDER_PARAM = z.object({ provider: z.enum(['anthropic']) });

export const aiCredentialsRoutes = new Hono()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const u = c.get('user');
    const rows = await db.select({
      provider: userAiCredentials.provider,
      modelPreference: userAiCredentials.modelPreference,
      updatedAt: userAiCredentials.updatedAt,
    }).from(userAiCredentials).where(eq(userAiCredentials.userId, u.id));

    return c.json({
      credentials: rows.map((r) => ({
        provider: r.provider,
        model_preference: r.modelPreference,
        updated_at: r.updatedAt,
        key_set: true,
      })),
      env_fallback_available: !!env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'placeholder',
      anthropic_models: ANTHROPIC_MODELS,
      default_model: DEFAULT_MODEL,
    });
  })
  .post('/', zValidator('json', setBody), async (c) => {
    const u = c.get('user');
    const { provider, api_key, model_preference } = c.req.valid('json');
    const enc = encryptToken(api_key, env.TOKEN_ENCRYPTION_KEY);
    await db.insert(userAiCredentials).values({
      userId: u.id, provider, apiKeyEnc: enc, modelPreference: model_preference ?? null,
    }).onConflictDoUpdate({
      target: [userAiCredentials.userId, userAiCredentials.provider],
      set: { apiKeyEnc: enc, modelPreference: model_preference ?? null, updatedAt: new Date() },
    });
    return c.json({ ok: true });
  })
  .delete('/:provider', zValidator('param', PROVIDER_PARAM), async (c) => {
    const u = c.get('user');
    const { provider } = c.req.valid('param');
    await db.delete(userAiCredentials).where(and(eq(userAiCredentials.userId, u.id), eq(userAiCredentials.provider, provider)));
    return c.json({ ok: true });
  });
