import { defineConfig } from 'vitest/config';
import 'dotenv/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/tasktalk',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-test',
      CLICKUP_OAUTH_CLIENT_ID: process.env.CLICKUP_OAUTH_CLIENT_ID ?? 'test-id',
      CLICKUP_OAUTH_CLIENT_SECRET: process.env.CLICKUP_OAUTH_CLIENT_SECRET ?? 'test-secret',
      CLICKUP_WEBHOOK_SECRET: process.env.CLICKUP_WEBHOOK_SECRET ?? 'test-secret',
      RESEND_API_KEY: process.env.RESEND_API_KEY ?? 'test-rs',
      TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY ?? 'a'.repeat(64),
      SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET ?? 'b'.repeat(32),
      PROCESS_ROLE: process.env.PROCESS_ROLE ?? 'web',
      BASE_URL: process.env.BASE_URL ?? 'http://localhost:3000',
    },
  },
});
