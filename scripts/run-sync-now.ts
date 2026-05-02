// Usage: tsx scripts/run-sync-now.ts <userEmail>
// Runs runInitialSync directly (bypassing pg-boss queue) for fast verification.
import '../src/server/load-env.js';
import { db } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { runInitialSync } from '../src/server/sync/initial-sync.js';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/run-sync-now.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error('user not found'); process.exit(1); }

console.log(`[run-sync-now] starting initial sync for ${u.email} (${u.id})`);
const start = Date.now();
try {
  await runInitialSync({ userId: u.id });
  console.log(`[run-sync-now] completed in ${Date.now() - start}ms`);
} catch (err) {
  console.error('[run-sync-now] failed:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(2);
}
process.exit(0);
