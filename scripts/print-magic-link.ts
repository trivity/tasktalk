// Usage: tsx scripts/print-magic-link.ts <email>
import 'dotenv/config';
import { db } from '../src/server/db/client.js';
import { users, authTokens } from '../src/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/print-magic-link.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error('user not found'); process.exit(1); }

const [t] = await db.select().from(authTokens)
  .where(eq(authTokens.userId, u.id))
  .orderBy(desc(authTokens.createdAt)).limit(1);

if (!t) { console.error('no token issued for user'); process.exit(1); }

console.log('IMPORTANT: this is the hashed token, not the raw token.');
console.log('In dev, the raw token is logged to the server console on issue.');
console.log(`Token row id: ${t.id}, created_at: ${t.createdAt.toISOString()}`);
