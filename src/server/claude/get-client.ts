import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import { userAiCredentials } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { decryptToken } from '../db/encrypt.js';
import { env } from '../env.js';

export const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (most capable)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
] as const;

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export type AiClientHandle = { client: Anthropic; model: string; source: 'user' | 'env' };

export async function getAiClientForUser(userId: string): Promise<AiClientHandle> {
  const [row] = await db
    .select()
    .from(userAiCredentials)
    .where(and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, 'anthropic')))
    .limit(1);

  if (row) {
    const apiKey = decryptToken(row.apiKeyEnc, env.TOKEN_ENCRYPTION_KEY);
    const model = row.modelPreference ?? DEFAULT_MODEL;
    return { client: new Anthropic({ apiKey }), model, source: 'user' };
  }

  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== 'placeholder') {
    return { client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), model: DEFAULT_MODEL, source: 'env' };
  }

  throw new Error('no_ai_credentials');
}
