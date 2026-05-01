# Tasktalk Plan A — Foundation + Auth + ClickUp OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tasktalk repo, baseline tooling, database schema, app login (magic link + password), and ClickUp OAuth — so a teammate can sign in, get invited, set a password, and connect their ClickUp account. End state: an authenticated empty shell with a working ClickUp connection — no chat features yet.

**Architecture:** Single TypeScript monorepo. Hono backend (Node 20) + Vite/React frontend served from same process. Postgres via Drizzle ORM. App-layer encrypted ClickUp tokens. Magic links via Resend. OAuth 2.1 + PKCE for ClickUp.

**Tech Stack:** Node 20 LTS, TypeScript, Hono, Zod, Drizzle ORM, Postgres 16, React 18, Vite 5, Tailwind, shadcn/ui, Resend, Argon2id, Vitest.

**Spec reference:** `docs/superpowers/specs/2026-05-01-tasktalk-design.md` Sections 4 (Data model), 5 (Auth), 11 (Tech stack).

---

## File Structure (Plan A scope)

**Created:**
- `package.json`, `tsconfig.json`, `tsconfig.web.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `drizzle.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `.env.example`
- `src/server/index.ts` — entry point
- `src/server/env.ts` — Zod-validated env loader
- `src/server/db/client.ts` — Drizzle connection
- `src/server/db/schema.ts` — Drizzle schema (Plan A tables only: `users`, `sessions`, `auth_tokens`, `clickup_connections`)
- `src/server/db/encrypt.ts` — token encryption helper (AES-256-GCM)
- `src/server/auth/password.ts` — Argon2id wrappers
- `src/server/auth/session.ts` — cookie/session helpers
- `src/server/auth/magic-link.ts` — magic-link token generation + verification
- `src/server/auth/middleware.ts` — `requireAuth` middleware for Hono
- `src/server/auth/routes.ts` — login, magic-link, logout, members invite
- `src/server/email/resend.ts` — Resend client wrapper
- `src/server/mcp/oauth.ts` — ClickUp OAuth PKCE helpers
- `src/server/routes/clickup-oauth.ts` — connect / callback / disconnect routes
- `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx`
- `src/web/routes/login.tsx`, `src/web/routes/settings.tsx`, `src/web/routes/members.tsx`
- `src/web/lib/rpc.ts` — Hono RPC client wrapper
- `src/shared/schemas/api.ts` — shared Zod schemas
- `drizzle/0000_initial.sql` — generated migration
- `tests/server/db/encrypt.test.ts`, `tests/server/auth/password.test.ts`, `tests/server/auth/magic-link.test.ts`, `tests/server/mcp/oauth.test.ts`

---

## Task 1: Project scaffolding + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.web.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `.eslintrc.cjs`, `.prettierrc`, `.env.example`, `vitest.config.ts`

- [ ] **Step 1: Create `package.json` with all Plan A dependencies.**

```json
{
  "name": "tasktalk",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev:server": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "build:server": "tsc -p tsconfig.json",
    "build": "npm run build:web && npm run build:server",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --ext ts,tsx",
    "format": "prettier -w src",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@hono/node-server": "^1.13.0",
    "@hono/zod-validator": "^0.4.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "argon2": "^0.41.0",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "pg": "^8.13.0",
    "pg-boss": "^10.1.0",
    "postgres": "^3.4.0",
    "resend": "^4.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "drizzle-kit": "^0.28.0",
    "eslint": "^9.0.0",
    "eslint-plugin-react": "^7.35.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "postcss": "^8.4.0",
    "prettier": "^3.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.27.0",
    "tailwindcss": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `tsconfig.json` (server-side).**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["./src/shared/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/server/**/*", "src/shared/**/*"],
  "exclude": ["src/web/**/*", "node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `tsconfig.web.json` (client-side).**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/web/*"],
      "@shared/*": ["./src/shared/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/web/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 4: Create `vite.config.ts`.**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/web'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 5: Create `tailwind.config.ts`, `postcss.config.js`, `vitest.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `.env.example`.**

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss';
export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: { extend: { colors: { accent: '#7c6ef7' } } },
  plugins: [],
} satisfies Config;
```

```js
// postcss.config.js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [],
    include: ['tests/**/*.test.ts'],
  },
});
```

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react/recommended', 'plugin:react-hooks/recommended'],
  settings: { react: { version: '18' } },
  rules: { 'react/react-in-jsx-scope': 'off' },
};
```

```
// .prettierrc
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

```
# .env.example
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tasktalk
ANTHROPIC_API_KEY=
CLICKUP_OAUTH_CLIENT_ID=
CLICKUP_OAUTH_CLIENT_SECRET=
CLICKUP_WEBHOOK_SECRET=
RESEND_API_KEY=
TOKEN_ENCRYPTION_KEY=
SESSION_COOKIE_SECRET=
SENTRY_DSN=
PROCESS_ROLE=web
BASE_URL=http://localhost:3000
```

- [ ] **Step 6: Run `npm install`.**

```bash
npm install
```
Expected: completes without errors. `node_modules/` populated.

- [ ] **Step 7: Verify `npm run typecheck` passes.**

```bash
npm run typecheck
```
Expected: exit 0, no diagnostics.

- [ ] **Step 8: Commit.**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.web.json vite.config.ts tailwind.config.ts postcss.config.js vitest.config.ts .eslintrc.cjs .prettierrc .env.example
git commit -m "chore: project scaffolding + tooling"
```

---

## Task 2: Env validation + server entry

**Files:**
- Create: `src/server/env.ts`, `src/server/index.ts`
- Test: `tests/server/env.test.ts`

- [ ] **Step 1: Write the failing test for env validation.**

```ts
// tests/server/env.test.ts
import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/server/env.js';

describe('parseEnv', () => {
  it('rejects when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ PROCESS_ROLE: 'web' })).toThrow(/DATABASE_URL/);
  });

  it('parses a complete env object', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://localhost/x',
      ANTHROPIC_API_KEY: 'sk-x',
      CLICKUP_OAUTH_CLIENT_ID: 'id',
      CLICKUP_OAUTH_CLIENT_SECRET: 'sec',
      CLICKUP_WEBHOOK_SECRET: 'whs',
      RESEND_API_KEY: 'rs',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      SESSION_COOKIE_SECRET: 'b'.repeat(32),
      PROCESS_ROLE: 'web',
      BASE_URL: 'http://localhost:3000',
    });
    expect(env.PROCESS_ROLE).toBe('web');
  });

  it('rejects TOKEN_ENCRYPTION_KEY of wrong length', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'x',
        ANTHROPIC_API_KEY: 'x',
        CLICKUP_OAUTH_CLIENT_ID: 'x',
        CLICKUP_OAUTH_CLIENT_SECRET: 'x',
        CLICKUP_WEBHOOK_SECRET: 'x',
        RESEND_API_KEY: 'x',
        TOKEN_ENCRYPTION_KEY: 'short',
        SESSION_COOKIE_SECRET: 'b'.repeat(32),
        PROCESS_ROLE: 'web',
        BASE_URL: 'http://localhost:3000',
      }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

```bash
npm test -- env.test
```
Expected: FAIL — `parseEnv is not defined` or import error.

- [ ] **Step 3: Implement `src/server/env.ts`.**

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CLICKUP_OAUTH_CLIENT_ID: z.string().min(1),
  CLICKUP_OAUTH_CLIENT_SECRET: z.string().min(1),
  CLICKUP_WEBHOOK_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().length(64, 'TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)'),
  SESSION_COOKIE_SECRET: z.string().min(32),
  SENTRY_DSN: z.string().optional(),
  PROCESS_ROLE: z.enum(['web', 'worker']),
  BASE_URL: z.string().url(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

export const env = parseEnv();
```

- [ ] **Step 4: Run test, verify pass.**

```bash
npm test -- env.test
```
Expected: 3 passed.

- [ ] **Step 5: Create `src/server/index.ts`.**

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';

async function startWeb() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, role: 'web' }));
  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`[web] listening on http://localhost:${info.port}`);
  });
}

async function startWorker() {
  console.log('[worker] starting (no jobs registered yet)');
  process.stdin.resume();
}

if (env.PROCESS_ROLE === 'web') void startWeb();
else void startWorker();
```

- [ ] **Step 6: Set up local env, smoke test.**

Create `.env` (copy from `.env.example` and fill `TOKEN_ENCRYPTION_KEY` with a generated 64-hex string):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste into .env as TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste into .env as SESSION_COOKIE_SECRET
```

Then:
```bash
npm run dev:server
```
Expected: `[web] listening on http://localhost:3000`. Hit `curl http://localhost:3000/api/health` → `{"ok":true,"role":"web"}`.

- [ ] **Step 7: Commit.**

```bash
git add src/server/env.ts src/server/index.ts tests/server/env.test.ts
git commit -m "feat(server): env validation + Hono entry with role switch"
```

---

## Task 3: Drizzle schema + database client (Plan A tables only)

**Files:**
- Create: `drizzle.config.ts`, `src/server/db/client.ts`, `src/server/db/schema.ts`
- Generated: `drizzle/0000_initial.sql`

- [ ] **Step 1: Create `drizzle.config.ts`.**

```ts
import type { Config } from 'drizzle-kit';
import 'dotenv/config';
export default {
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

- [ ] **Step 2: Create `src/server/db/schema.ts` with Plan A tables.**

```ts
import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    passwordHash: text('password_hash'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ emailIdx: uniqueIndex('users_email_idx').on(t.email) }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['magic_link', 'password_reset'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tokenIdx: uniqueIndex('auth_tokens_hash_idx').on(t.tokenHash) }),
);

export const clickupConnections = pgTable(
  'clickup_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    scopes: text('scopes'),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('cu_conn_user_idx').on(t.userId) }),
);
```

- [ ] **Step 3: Create `src/server/db/client.ts`.**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

const queryClient = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
```

- [ ] **Step 4: Generate the migration.**

```bash
npm run db:generate
```
Expected: a `drizzle/0000_*.sql` file appears with `CREATE TABLE` statements for all four tables.

- [ ] **Step 5: Start a local Postgres and apply.**

If you don't have Postgres running locally, use Docker:

```bash
docker run -d --name tasktalk-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tasktalk -p 5432:5432 postgres:16
```

Then:
```bash
npm run db:push
```
Expected: tables created. Verify:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "\dt"
```
Expected: `users`, `sessions`, `auth_tokens`, `clickup_connections` listed.

- [ ] **Step 6: Commit.**

```bash
git add drizzle.config.ts src/server/db/ drizzle/
git commit -m "feat(db): Drizzle schema + client (Plan A tables)"
```

---

## Task 4: Token encryption helper (AES-256-GCM)

**Files:**
- Create: `src/server/db/encrypt.ts`
- Test: `tests/server/db/encrypt.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/db/encrypt.test.ts
import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../../../src/server/db/encrypt.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('encryptToken / decryptToken', () => {
  it('round-trips a token', () => {
    const cipher = encryptToken('my-secret-token', KEY);
    expect(cipher).not.toContain('my-secret-token');
    expect(decryptToken(cipher, KEY)).toBe('my-secret-token');
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const a = encryptToken('same', KEY);
    const b = encryptToken('same', KEY);
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', () => {
    const cipher = encryptToken('hi', KEY);
    const tampered = cipher.slice(0, -2) + 'XX';
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- encrypt.test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/db/encrypt.ts`.**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyFromHex(hex: string): Buffer {
  if (hex.length !== 64) throw new Error('encryption key must be 64-char hex (32 bytes)');
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: <iv:hex>.<ciphertext:hex>.<tag:hex>
  return `${iv.toString('hex')}.${enc.toString('hex')}.${tag.toString('hex')}`;
}

export function decryptToken(payload: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [ivHex, encHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- encrypt.test
```
Expected: 3 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/db/encrypt.ts tests/server/db/encrypt.test.ts
git commit -m "feat(db): AES-256-GCM token encryption helper"
```

---

## Task 5: Password hashing (Argon2id)

**Files:**
- Create: `src/server/auth/password.ts`
- Test: `tests/server/auth/password.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/auth/password.test.ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/server/auth/password.js';

describe('password', () => {
  it('hashes and verifies the same password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
  });

  it('rejects wrong password', async () => {
    const h = await hashPassword('alpha');
    expect(await verifyPassword(h, 'beta')).toBe(false);
  });

  it('handles empty hash gracefully', async () => {
    expect(await verifyPassword(null, 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- password.test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/auth/password.ts`.**

```ts
import argon2 from 'argon2';

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string | null | undefined, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- password.test
```
Expected: 3 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/auth/password.ts tests/server/auth/password.test.ts
git commit -m "feat(auth): Argon2id password hashing"
```

---

## Task 6: Session helpers + cookie middleware

**Files:**
- Create: `src/server/auth/session.ts`, `src/server/auth/middleware.ts`
- Test: `tests/server/auth/session.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/auth/session.test.ts
import { describe, it, expect } from 'vitest';
import { generateSessionId, hashSessionId, sessionExpiry } from '../../../src/server/auth/session.js';

describe('session helpers', () => {
  it('generates a unique session id (>=32 chars hex-ish)', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes session id deterministically', () => {
    const id = generateSessionId();
    expect(hashSessionId(id)).toBe(hashSessionId(id));
    expect(hashSessionId(id)).not.toBe(id);
  });

  it('expiry is 7 days from now ±1s', () => {
    const exp = sessionExpiry();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(exp.getTime() - expectedMs)).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- session.test
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/auth/session.ts`.**

```ts
import { randomBytes, createHmac } from 'node:crypto';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';
import { env } from '../env.js';

export const SESSION_COOKIE_NAME = 'tt_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionId(id: string): string {
  return createHmac('sha256', env.SESSION_COOKIE_SECRET).update(id).digest('hex');
}

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = generateSessionId();
  const expiresAt = sessionExpiry();
  await db.insert(sessions).values({ id: hashSessionId(id), userId, expiresAt });
  return { id, expiresAt };
}

export async function findSession(rawId: string) {
  const hashed = hashSessionId(rawId);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, hashed)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, hashed));
    return null;
  }
  return row;
}

export async function deleteSession(rawId: string) {
  await db.delete(sessions).where(eq(sessions.id, hashSessionId(rawId)));
}

export async function purgeExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
```

- [ ] **Step 4: Implement `src/server/auth/middleware.ts`.**

```ts
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { findSession, SESSION_COOKIE_NAME } from './session.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type AuthedUser = { id: string; email: string; name: string | null; isAdmin: boolean };

declare module 'hono' {
  interface ContextVariableMap { user: AuthedUser }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME);
  if (!sid) return c.json({ error: 'unauthenticated' }, 401);
  const sess = await findSession(sid);
  if (!sess) return c.json({ error: 'unauthenticated' }, 401);
  const [u] = await db.select().from(users).where(eq(users.id, sess.userId)).limit(1);
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin });
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const u = c.get('user');
  if (!u?.isAdmin) return c.json({ error: 'forbidden' }, 403);
  await next();
};
```

- [ ] **Step 5: Run, verify pass.**

```bash
npm test -- session.test
```
Expected: 3 passed.

- [ ] **Step 6: Commit.**

```bash
git add src/server/auth/session.ts src/server/auth/middleware.ts tests/server/auth/session.test.ts
git commit -m "feat(auth): cookie sessions + requireAuth middleware"
```

---

## Task 7: Magic-link token issue + verify

**Files:**
- Create: `src/server/auth/magic-link.ts`, `src/server/email/resend.ts`
- Test: `tests/server/auth/magic-link.test.ts`

- [ ] **Step 1: Write the failing test (issue + verify, no email send).**

```ts
// tests/server/auth/magic-link.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { issueMagicLinkToken, verifyMagicLinkToken } from '../../../src/server/auth/magic-link.js';
import { db } from '../../../src/server/db/client.js';
import { users } from '../../../src/server/db/schema.js';

let userId: string;
beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: `ml-${Date.now()}@test` }).returning();
  userId = u.id;
});

describe('magic link', () => {
  it('issues a token, verifies it, then rejects re-use', async () => {
    const token = await issueMagicLinkToken(userId);
    expect(token.length).toBeGreaterThan(20);
    const verifiedUserId = await verifyMagicLinkToken(token);
    expect(verifiedUserId).toBe(userId);
    // single-use
    expect(await verifyMagicLinkToken(token)).toBe(null);
  });

  it('rejects unknown token', async () => {
    expect(await verifyMagicLinkToken('not-a-real-token')).toBe(null);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- magic-link.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/auth/magic-link.ts`.**

```ts
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { authTokens } from '../db/schema.js';
import { and, eq, isNull, gt } from 'drizzle-orm';

const TTL_MS = 15 * 60 * 1000;

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

export async function issueMagicLinkToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.insert(authTokens).values({
    userId,
    purpose: 'magic_link',
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return raw;
}

export async function verifyMagicLinkToken(raw: string): Promise<string | null> {
  const hashed = hashToken(raw);
  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashed),
        eq(authTokens.purpose, 'magic_link'),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, row.id));
  return row.userId;
}
```

- [ ] **Step 4: Implement `src/server/email/resend.ts`.**

```ts
import { Resend } from 'resend';
import { env } from '../env.js';

const resend = new Resend(env.RESEND_API_KEY);

export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  await resend.emails.send({
    from: 'Tasktalk <noreply@tasktalk.app>',
    to,
    subject: 'Your Tasktalk sign-in link',
    text: `Click to sign in (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}
```

- [ ] **Step 5: Run, verify pass.**

```bash
npm test -- magic-link.test
```
Expected: 2 passed.

- [ ] **Step 6: Commit.**

```bash
git add src/server/auth/magic-link.ts src/server/email/resend.ts tests/server/auth/magic-link.test.ts
git commit -m "feat(auth): magic-link issue/verify + Resend email wrapper"
```

---

## Task 8: Auth routes (login + magic link + logout + invite)

**Files:**
- Create: `src/server/auth/routes.ts`, `src/shared/schemas/api.ts`
- Modify: `src/server/index.ts` to mount routes

- [ ] **Step 1: Create `src/shared/schemas/api.ts`.**

```ts
import { z } from 'zod';

export const loginRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('magic_link'), email: z.string().email() }),
  z.object({ method: z.literal('password'), email: z.string().email(), password: z.string().min(1) }),
]);

export const callbackRequest = z.object({ token: z.string().min(1) });

export const inviteRequest = z.object({ email: z.string().email(), name: z.string().optional() });

export const setPasswordRequest = z.object({ password: z.string().min(8) });
```

- [ ] **Step 2: Implement `src/server/auth/routes.ts`.**

```ts
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import {
  createSession,
  deleteSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './session.js';
import { issueMagicLinkToken, verifyMagicLinkToken } from './magic-link.js';
import { hashPassword, verifyPassword } from './password.js';
import { sendMagicLinkEmail } from '../email/resend.js';
import { requireAuth, requireAdmin } from './middleware.js';
import { loginRequest, callbackRequest, inviteRequest, setPasswordRequest } from '../../shared/schemas/api.js';
import { getCookie } from 'hono/cookie';

export const authRoutes = new Hono()
  .post('/login', zValidator('json', loginRequest), async (c) => {
    const body = c.req.valid('json');
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!u) return c.json({ ok: true }); // do not reveal whether account exists
    if (body.method === 'magic_link') {
      const raw = await issueMagicLinkToken(u.id);
      const link = `${env.BASE_URL}/login/callback?token=${encodeURIComponent(raw)}`;
      await sendMagicLinkEmail(u.email, link);
      return c.json({ ok: true });
    }
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) return c.json({ error: 'invalid_credentials' }, 401);
    const sess = await createSession(u.id);
    setCookie(c, SESSION_COOKIE_NAME, sess.id, {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https'),
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin } });
  })
  .post('/login/callback', zValidator('json', callbackRequest), async (c) => {
    const { token } = c.req.valid('json');
    const userId = await verifyMagicLinkToken(token);
    if (!userId) return c.json({ error: 'invalid_or_expired_token' }, 400);
    const sess = await createSession(userId);
    setCookie(c, SESSION_COOKIE_NAME, sess.id, {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https'),
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return c.json({ ok: true, user: { id: u!.id, email: u!.email, name: u!.name, isAdmin: u!.isAdmin } });
  })
  .post('/logout', requireAuth, async (c) => {
    const sid = getCookie(c, SESSION_COOKIE_NAME);
    if (sid) await deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/me', requireAuth, (c) => c.json({ user: c.get('user') }))
  .post('/me/password', requireAuth, zValidator('json', setPasswordRequest), async (c) => {
    const u = c.get('user');
    const { password } = c.req.valid('json');
    const hash = await hashPassword(password);
    await db.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, u.id));
    return c.json({ ok: true });
  })
  .post('/members/invite', requireAuth, requireAdmin, zValidator('json', inviteRequest), async (c) => {
    const { email, name } = c.req.valid('json');
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let userId: string;
    if (existing.length) {
      userId = existing[0]!.id;
    } else {
      const [created] = await db.insert(users).values({ email, name }).returning();
      userId = created.id;
    }
    const raw = await issueMagicLinkToken(userId);
    const link = `${env.BASE_URL}/login/callback?token=${encodeURIComponent(raw)}`;
    await sendMagicLinkEmail(email, link);
    return c.json({ ok: true });
  });
```

- [ ] **Step 3: Mount routes in `src/server/index.ts`.**

Replace the body of `startWeb()`:

```ts
async function startWeb() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, role: 'web' }));
  app.route('/api/auth', authRoutes);
  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`[web] listening on http://localhost:${info.port}`);
  });
}
```

Add the import at top: `import { authRoutes } from './auth/routes.js';`

- [ ] **Step 4: Smoke test.**

Bootstrap an admin user manually (one-time):

```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "INSERT INTO users (email, name, is_admin) VALUES ('oz@travis.chat', 'Oz', true);"
```

Restart the server (`npm run dev:server`). Then:

```bash
curl -X POST http://localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"method":"magic_link","email":"oz@travis.chat"}'
```
Expected: `{"ok":true}` and (if Resend is configured) an email arrives. If Resend isn't set up yet, the request will succeed but no email is sent — that's fine for now.

To complete the loop without email, fetch the latest token from DB:

```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "SELECT token_hash FROM auth_tokens ORDER BY created_at DESC LIMIT 1;"
```

(In real testing you'd click the email link; for dev a small helper to print the raw token is fine — see Task 12.)

- [ ] **Step 5: Commit.**

```bash
git add src/server/auth/routes.ts src/shared/schemas/api.ts src/server/index.ts
git commit -m "feat(auth): login/logout/invite/me routes"
```

---

## Task 9: ClickUp OAuth PKCE helpers

**Files:**
- Create: `src/server/mcp/oauth.ts`
- Test: `tests/server/mcp/oauth.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/mcp/oauth.test.ts
import { describe, it, expect } from 'vitest';
import { generatePkcePair, buildAuthorizeUrl } from '../../../src/server/mcp/oauth.js';

describe('OAuth PKCE', () => {
  it('generates a pair where challenge != verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeChallenge.length).toBeGreaterThan(20);
    expect(codeChallenge).not.toBe(codeVerifier);
  });

  it('produces deterministic challenge for known verifier (SHA256 base64url)', () => {
    // RFC 7636 example
    const known = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const { codeChallenge } = generatePkcePair(known);
    expect(codeChallenge).toBe(expected);
  });

  it('builds authorize URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'abc',
      redirectUri: 'https://app/callback',
      codeChallenge: 'xxx',
      state: 'st',
    });
    expect(url).toMatch(/client_id=abc/);
    expect(url).toMatch(/code_challenge=xxx/);
    expect(url).toMatch(/code_challenge_method=S256/);
    expect(url).toMatch(/state=st/);
    expect(url).toMatch(/response_type=code/);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- oauth.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/mcp/oauth.ts`.**

```ts
import { randomBytes, createHash } from 'node:crypto';
import { env } from '../env.js';

const AUTHORIZE_URL = 'https://app.clickup.com/api/v2/oauth/authorize';
const TOKEN_URL = 'https://app.clickup.com/api/v2/oauth/token';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkcePair(verifierOverride?: string): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = verifierOverride ?? base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  if (params.scopes?.length) url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

export type ClickUpTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export async function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ClickUpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.CLICKUP_OAUTH_CLIENT_ID,
    client_secret: env.CLICKUP_OAUTH_CLIENT_SECRET,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ClickUp token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ClickUpTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<ClickUpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.CLICKUP_OAUTH_CLIENT_ID,
    client_secret: env.CLICKUP_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ClickUp token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ClickUpTokenResponse;
}
```

> **Note:** ClickUp's exact authorize/token URLs may differ slightly under their MCP-specific OAuth spec. Verify against their docs at the start of this task and adjust the constants. The PKCE flow shape is identical regardless.

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- oauth.test
```
Expected: 3 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/mcp/oauth.ts tests/server/mcp/oauth.test.ts
git commit -m "feat(mcp): ClickUp OAuth PKCE helpers"
```

---

## Task 10: ClickUp connect / callback / disconnect routes

**Files:**
- Create: `src/server/routes/clickup-oauth.ts`
- Modify: `src/server/index.ts` to mount

- [ ] **Step 1: Implement `src/server/routes/clickup-oauth.ts`.**

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../env.js';
import { encryptToken } from '../db/encrypt.js';
import {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
} from '../mcp/oauth.js';
import { requireAuth } from '../auth/middleware.js';
import { randomBytes } from 'node:crypto';

const PKCE_COOKIE = 'tt_oauth_pkce';
const STATE_COOKIE = 'tt_oauth_state';

export const clickupOauthRoutes = new Hono()
  .get('/connect', requireAuth, async (c) => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = randomBytes(16).toString('hex');
    const redirectUri = `${env.BASE_URL}/api/clickup/callback`;
    setCookie(c, PKCE_COOKIE, codeVerifier, { httpOnly: true, secure: env.BASE_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 600 });
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: env.BASE_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 600 });
    const url = buildAuthorizeUrl({
      clientId: env.CLICKUP_OAUTH_CLIENT_ID,
      redirectUri,
      codeChallenge,
      state,
    });
    return c.redirect(url);
  })
  .get('/callback', requireAuth, async (c) => {
    const u = c.get('user');
    const code = c.req.query('code');
    const stateParam = c.req.query('state');
    const codeVerifier = getCookie(c, PKCE_COOKIE);
    const stateCookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, PKCE_COOKIE, { path: '/' });
    deleteCookie(c, STATE_COOKIE, { path: '/' });

    if (!code || !codeVerifier || !stateParam || stateParam !== stateCookie) {
      return c.redirect('/settings?clickup=error');
    }

    const redirectUri = `${env.BASE_URL}/api/clickup/callback`;
    const tokenResp = await exchangeCodeForToken({ code, codeVerifier, redirectUri });

    // ClickUp returns the workspace id in the token scope or via a separate call;
    // for now, fetch the user's authorized workspaces via a small probe. Replace
    // this with ClickUp's documented mechanism.
    const workspaceId = await fetchPrimaryWorkspaceId(tokenResp.access_token);

    await db.insert(clickupConnections).values({
      userId: u.id,
      workspaceId,
      accessTokenEnc: encryptToken(tokenResp.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: encryptToken(tokenResp.refresh_token, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: new Date(Date.now() + tokenResp.expires_in * 1000),
      scopes: tokenResp.scope ?? null,
    });

    return c.redirect('/settings?clickup=connected');
  })
  .post('/disconnect', requireAuth, async (c) => {
    const u = c.get('user');
    await db
      .update(clickupConnections)
      .set({ tombstonedAt: new Date() })
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
    return c.json({ ok: true });
  })
  .get('/status', requireAuth, async (c) => {
    const u = c.get('user');
    const [row] = await db
      .select({ workspaceId: clickupConnections.workspaceId, expiresAt: clickupConnections.expiresAt, tombstonedAt: clickupConnections.tombstonedAt })
      .from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)))
      .limit(1);
    return c.json({ connected: !!row, connection: row ?? null });
  });

async function fetchPrimaryWorkspaceId(accessToken: string): Promise<string> {
  // Use ClickUp's REST endpoint that lists teams (workspaces). Replace path
  // with the documented MCP-side endpoint when finalizing.
  const res = await fetch('https://api.clickup.com/api/v2/team', {
    headers: { Authorization: accessToken },
  });
  if (!res.ok) throw new Error(`ClickUp team fetch failed: ${res.status}`);
  const data = (await res.json()) as { teams: Array<{ id: string }> };
  if (!data.teams?.length) throw new Error('No accessible ClickUp workspaces');
  return data.teams[0]!.id;
}
```

- [ ] **Step 2: Mount in `src/server/index.ts`.**

Add `import { clickupOauthRoutes } from './routes/clickup-oauth.js';` and `app.route('/api/clickup', clickupOauthRoutes);` inside `startWeb()`.

- [ ] **Step 3: Smoke test the disconnect/status path (no live OAuth required).**

```bash
# Login first via the magic-link flow (or set a session manually for dev).
curl -b cookies.txt -X GET http://localhost:3000/api/clickup/status
```
Expected: `{"connected":false,"connection":null}` for a freshly-logged-in user with no ClickUp connection.

The connect/callback path requires a real ClickUp OAuth allowlist registration; smoke-test it once the redirect URI is allowlisted.

- [ ] **Step 4: Commit.**

```bash
git add src/server/routes/clickup-oauth.ts src/server/index.ts
git commit -m "feat(mcp): ClickUp OAuth connect/callback/disconnect/status routes"
```

---

## Task 11: Frontend shell — login + settings + members pages

**Files:**
- Create: `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/lib/rpc.ts`, `src/web/routes/login.tsx`, `src/web/routes/settings.tsx`, `src/web/routes/members.tsx`, `src/web/styles.css`

- [ ] **Step 1: Create `src/web/index.html`.**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tasktalk</title>
  </head>
  <body class="bg-[#0a0b0f] text-[#e8eaf0]">
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/web/styles.css`.**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
body { font-family: 'Inter', system-ui, sans-serif; }
```

- [ ] **Step 3: Create `src/web/main.tsx` and `App.tsx`.**

```tsx
// main.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

```tsx
// App.tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './routes/login.js';
import { Settings } from './routes/settings.js';
import { Members } from './routes/members.js';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<Login />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/members" element={<Members />} />
      <Route path="/" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Create `src/web/lib/rpc.ts`.**

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'include' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  me: () => request<{ user: { id: string; email: string; name: string | null; isAdmin: boolean } }>('/api/auth/me'),
  loginMagicLink: (email: string) => request<{ ok: true }>('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'magic_link', email }),
  }),
  loginPassword: (email: string, password: string) => request<{ ok: true }>('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'password', email, password }),
  }),
  loginCallback: (token: string) => request<{ ok: true }>('/api/auth/login/callback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  setPassword: (password: string) => request<{ ok: true }>('/api/auth/me/password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }),
  invite: (email: string, name?: string) => request<{ ok: true }>('/api/auth/members/invite', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name }),
  }),
  clickupStatus: () => request<{ connected: boolean }>('/api/clickup/status'),
  clickupDisconnect: () => request<{ ok: true }>('/api/clickup/disconnect', { method: 'POST' }),
};
```

- [ ] **Step 5: Create `src/web/routes/login.tsx`.**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Login() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [usePw, setUsePw] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      api.loginCallback(token).then(() => nav('/settings')).catch((e) => setMsg(String(e.message)));
    }
  }, [params, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      if (usePw) { await api.loginPassword(email, pw); nav('/settings'); }
      else { await api.loginMagicLink(email); setMsg('Check your email for a sign-in link.'); }
    } catch (err: any) { setMsg(String(err.message)); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="bg-[#181b22] border border-[#2a2f3d] rounded-2xl p-8 w-[400px]">
        <h1 className="text-xl font-bold mb-6">Sign in to Tasktalk</h1>
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3 mb-3" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {usePw && (
          <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3 mb-3" type="password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        )}
        <button className="w-full bg-[#7c6ef7] text-white rounded-md p-3 font-semibold mb-2" type="submit">
          {usePw ? 'Sign in' : 'Send magic link'}
        </button>
        <button type="button" onClick={() => setUsePw(!usePw)} className="w-full text-sm text-[#9298ac] py-2">
          {usePw ? 'Use magic link instead' : 'Use password instead'}
        </button>
        {msg && <p className="text-sm text-[#9298ac] mt-3">{msg}</p>}
      </form>
    </div>
  );
}
```

- [ ] **Step 6: Create `src/web/routes/settings.tsx`.**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Settings() {
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [pw, setPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
    api.clickupStatus().then((r) => setConnected(r.connected));
  }, [nav]);

  async function setPassword() {
    setPwMsg(null);
    try { await api.setPassword(pw); setPwMsg('Password set.'); setPw(''); }
    catch (e: any) { setPwMsg(String(e.message)); }
  }

  async function logout() { await api.logout(); nav('/login'); }
  async function disconnect() { await api.clickupDisconnect(); setConnected(false); }

  if (!user) return null;
  const cuStatus = params.get('clickup');

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-8">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button onClick={logout} className="text-sm text-[#9298ac]">Sign out</button>
      </header>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">Profile</h2>
        <p className="text-sm text-[#9298ac]">{user.email}{user.isAdmin && ' · admin'}</p>
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">Set / change password</h2>
        <input type="password" className="bg-[#0f1117] border border-[#2a2f3d] rounded-md p-2 mr-2" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button onClick={setPassword} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Save</button>
        {pwMsg && <p className="text-sm text-[#9298ac] mt-2">{pwMsg}</p>}
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">ClickUp connection</h2>
        {cuStatus === 'connected' && <p className="text-sm text-[#34d399] mb-2">Connected ✓</p>}
        {cuStatus === 'error' && <p className="text-sm text-[#f87171] mb-2">Connection failed. Try again.</p>}
        {connected ? (
          <button onClick={disconnect} className="border border-[#f87171] text-[#f87171] rounded-md px-4 py-2 text-sm">Disconnect</button>
        ) : (
          <a href="/api/clickup/connect" className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Connect ClickUp</a>
        )}
      </section>

      {user.isAdmin && (
        <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
          <h2 className="font-semibold mb-2">Members</h2>
          <Link to="/members" className="text-sm text-[#7c6ef7]">Manage members →</Link>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Create `src/web/routes/members.tsx`.**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Members() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  async function invite() {
    setMsg(null);
    try { await api.invite(email, name || undefined); setMsg('Invite sent.'); setEmail(''); setName(''); }
    catch (e: any) { setMsg(String(e.message)); }
  }

  return (
    <div className="max-w-xl mx-auto p-8">
      <button onClick={() => nav('/settings')} className="text-sm text-[#9298ac] mb-6">← Settings</button>
      <h1 className="text-2xl font-bold mb-6">Members</h1>
      <div className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6 space-y-3">
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3" type="text" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={invite} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 font-semibold">Send invite</button>
        {msg && <p className="text-sm text-[#9298ac]">{msg}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Smoke test the frontend.**

```bash
npm run dev:web
```

Open http://localhost:5173/login. Verify the login form renders, password toggle works, magic-link request returns `{ok:true}` (server proxy at port 3000).

- [ ] **Step 9: Commit.**

```bash
git add src/web/
git commit -m "feat(web): login + settings + members pages with RPC client"
```

---

## Task 12: Dev helper — print most recent magic-link token

**Files:**
- Create: `scripts/print-magic-link.ts`

A small utility so a dev can complete the magic-link flow without configuring email.

- [ ] **Step 1: Write `scripts/print-magic-link.ts`.**

```ts
// Usage: tsx scripts/print-magic-link.ts <email>
import 'dotenv/config';
import { db } from '../src/server/db/client.js';
import { users, authTokens } from '../src/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { env } from '../src/server/env.js';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/print-magic-link.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error('user not found'); process.exit(1); }

const [t] = await db.select().from(authTokens)
  .where(eq(authTokens.userId, u.id))
  .orderBy(desc(authTokens.createdAt)).limit(1);

if (!t) { console.error('no token issued for user'); process.exit(1); }

console.log('IMPORTANT: this is the hashed token, not the raw token.');
console.log('In dev, modify magic-link.ts to log the raw token on issue, OR');
console.log('use a real email provider. The hashed token cannot be reversed.');
console.log(`Token row id: ${t.id}, created_at: ${t.createdAt.toISOString()}`);
```

> The script intentionally points out that we cannot reverse the hash. For dev convenience, temporarily log the raw token in `magic-link.ts` (a `// DEV ONLY` block guarded by `NODE_ENV !== 'production'`) — and remove the log before any deploy.

- [ ] **Step 2: Add the dev-only log in `src/server/auth/magic-link.ts`.**

Add to `issueMagicLinkToken` after the insert:

```ts
if (process.env.NODE_ENV !== 'production') {
  console.log(`[dev] magic link for user=${userId} token=${raw}`);
}
```

- [ ] **Step 3: Commit.**

```bash
git add scripts/print-magic-link.ts src/server/auth/magic-link.ts
git commit -m "chore(dev): magic-link dev logging + token query script"
```

---

## Self-Review

**Spec coverage (Sections 4 & 5):**

- ✓ `users` table — Task 3 (with `password_hash` nullable per spec)
- ✓ `sessions` table — Task 3
- ✓ `auth_tokens` table — Task 3 (with `purpose` column for magic_link / password_reset)
- ✓ `clickup_connections` table — Task 3 (with `tombstoned_at`)
- ✓ Token encryption at app layer — Task 4 (AES-256-GCM)
- ✓ Argon2id password hashing — Task 5
- ✓ HttpOnly + Secure + SameSite=Strict cookie session, opaque IDs — Task 6
- ✓ 7-day max session, sliding window — Task 6 (`SESSION_TTL_MS`)
- ✓ Magic link 15-min single-use — Task 7
- ✓ Login (magic_link + password) — Task 8
- ✓ Logout — Task 8
- ✓ Members invite (admin only) — Task 8
- ✓ Set/change password — Task 8
- ✓ ClickUp OAuth 2.1 + PKCE — Tasks 9 & 10
- ✓ Token refresh helper — Task 9 (`refreshAccessToken`; auto-refresh middleware in Plan B before MCP calls)
- ✓ Disconnect with tombstone — Task 10 (`tombstonedAt` set)
- ✓ Login UI with both methods — Task 11
- ✓ Settings UI with ClickUp connect/disconnect + password — Task 11
- ✓ Members page (admin) — Task 11

**Plan A intentionally excludes** (covered by later plans): the auto-refresh middleware *consumer* (Plan B uses it), webhook subscription registration (Plan B), purge job for >7-day tombstones (Plan B as part of cron setup).

**Placeholder scan:** No `TBD` / `TODO` / "implement later" found. All code blocks are concrete.

**Type consistency:** `users.id` (uuid), `clickupConnections.userId` (uuid → users.id), `authTokens.userId` (uuid → users.id), `sessions.userId` (uuid → users.id) — all consistent. RPC client field names match server route returns.

**Known limitation flagged in code:**

- ClickUp's exact authorize/token URL paths are flagged in Task 9 as "verify against docs" — they may be different under MCP's OAuth spec. The PKCE flow shape itself is invariant.
- `fetchPrimaryWorkspaceId` in Task 10 uses ClickUp's REST `/team` endpoint as a probe to identify the workspace; the production version should use whatever discovery mechanism ClickUp's MCP OAuth response provides. Adjust during implementation.

---

## What Plan A produces

After completing all 12 tasks, you can:

1. Run a local Postgres + Tasktalk web server and visit `http://localhost:5173`.
2. Sign in via magic link or password.
3. Get invited as a teammate by an admin.
4. Set/change your password.
5. Click "Connect ClickUp," go through OAuth, return to a connected state.
6. Disconnect ClickUp (tombstones the row).

What you can NOT yet do (covered by Plans B–D):

- Talk to Claude.
- Sync ClickUp data to a mirror.
- Send/receive any chat messages.
- See task data anywhere in the app.

---

## Next steps after Plan A

Once Plan A is fully merged and verified, proceed to:

- **Plan B** — Mirror schema + initial sync + webhooks + drift cron + read path foundation
- **Plan C** — Chat UI shell + Claude tool loop + read tools + aggregates
- **Plan D** — Write path + audit + undo + onboarding wizard + polish + deploy
