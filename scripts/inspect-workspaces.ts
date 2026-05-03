// Usage: tsx scripts/inspect-workspaces.ts <userEmail>
// Prints the user's active clickup_connections and per-workspace task counts.
import '../src/server/load-env.js';
import { db } from '../src/server/db/client.js';
import { users, clickupConnections, cuWorkspaces } from '../src/server/db/schema.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/inspect-workspaces.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error(`user not found: ${email}`); process.exit(1); }

const conns = await db
  .select()
  .from(clickupConnections)
  .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
console.log(`\n# active connections for ${email}:`);
for (const c of conns) {
  console.log(`- workspace_id=${c.workspaceId} expires=${c.expiresAt.toISOString()} created=${c.createdAt.toISOString()}`);
}

if (conns.length === 0) process.exit(0);

const ids = conns.map((c) => c.workspaceId);
const wsRows = await db.select().from(cuWorkspaces).where(inArray(cuWorkspaces.workspaceId, ids));
console.log('\n# cu_workspaces rows:');
for (const w of wsRows) {
  console.log(`- ${w.workspaceId} ${w.name} last_full=${w.lastFullSyncAt?.toISOString() ?? 'never'} last_inc=${w.lastIncrementalSyncAt?.toISOString() ?? 'never'} state=${JSON.stringify(w.syncState)}`);
}

const counts = await db.execute(sql`SELECT workspace_id, count(*)::int AS c FROM cu_tasks WHERE workspace_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY workspace_id`);
console.log('\n# cu_tasks counts:');
for (const r of counts as unknown as Array<{ workspace_id: string; c: number }>) {
  console.log(`- ${r.workspace_id}: ${r.c} tasks`);
}
process.exit(0);
