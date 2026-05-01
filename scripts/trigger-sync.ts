// Usage: tsx scripts/trigger-sync.ts <userEmail>
import 'dotenv/config';
import { db } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getBoss, QUEUE_INITIAL_SYNC, stopBoss } from '../src/server/sync/boss.js';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/trigger-sync.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error('user not found'); process.exit(1); }

const boss = await getBoss();
const id = await boss.send(QUEUE_INITIAL_SYNC, { userId: u.id });
console.log(`enqueued initial-sync job ${id} for user ${u.email}`);
await stopBoss();
process.exit(0);
