import { db } from '../db/client.js';
import { clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { decryptToken, encryptToken } from '../db/encrypt.js';
import { env } from '../env.js';
import { refreshAccessToken } from './oauth.js';

const REFRESH_BUFFER_MS = 60_000;

export async function getValidAccessToken(userId: string): Promise<{ accessToken: string; workspaceId: string }> {
  const [row] = await db
    .select()
    .from(clickupConnections)
    .where(and(eq(clickupConnections.userId, userId), isNull(clickupConnections.tombstonedAt)))
    .limit(1);
  if (!row) throw new Error('No active ClickUp connection');

  const expiresAt = row.expiresAt.getTime();
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return {
      accessToken: decryptToken(row.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY),
      workspaceId: row.workspaceId,
    };
  }

  const refreshToken = decryptToken(row.refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken);
  await db
    .update(clickupConnections)
    .set({
      accessTokenEnc: encryptToken(fresh.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: encryptToken(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000),
    })
    .where(eq(clickupConnections.id, row.id));
  return { accessToken: fresh.access_token, workspaceId: row.workspaceId };
}
