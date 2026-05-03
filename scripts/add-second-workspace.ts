// Usage: tsx scripts/add-second-workspace.ts <userEmail> <newWorkspaceId>
// Inserts a new clickup_connections row for the given user, copying the
// encrypted access/refresh tokens, expires_at, and scopes from the user's
// existing active connection. Multi-workspace migration helper.
import '../src/server/load-env.js';
import { db } from '../src/server/db/client.js';
import { users, clickupConnections } from '../src/server/db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

const email = process.argv[2];
const newWsId = process.argv[3];
if (!email || !newWsId) {
  console.error('usage: tsx scripts/add-second-workspace.ts <email> <new_workspace_id>');
  process.exit(1);
}

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error(`user not found: ${email}`); process.exit(1); }

const existing = await db
  .select()
  .from(clickupConnections)
  .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
if (existing.length === 0) {
  console.error(`no active connection for user ${email}; OAuth first`);
  process.exit(1);
}
const dup = existing.find((c) => c.workspaceId === newWsId);
if (dup) {
  console.log(`workspace ${newWsId} already linked to ${email}; nothing to do`);
  process.exit(0);
}

const template = existing[0]!;
const inserted = await db.insert(clickupConnections).values({
  userId: u.id,
  workspaceId: newWsId,
  accessTokenEnc: template.accessTokenEnc,
  refreshTokenEnc: template.refreshTokenEnc,
  expiresAt: template.expiresAt,
  scopes: template.scopes,
}).returning();
console.log(`linked workspace ${newWsId} to ${email} (connection id ${inserted[0]?.id})`);
process.exit(0);
