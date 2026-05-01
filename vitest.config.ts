import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgres://localhost/test',
      ANTHROPIC_API_KEY: 'sk-test',
      CLICKUP_OAUTH_CLIENT_ID: 'test-id',
      CLICKUP_OAUTH_CLIENT_SECRET: 'test-secret',
      CLICKUP_WEBHOOK_SECRET: 'test-secret',
      RESEND_API_KEY: 'test-rs',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      SESSION_COOKIE_SECRET: 'b'.repeat(32),
      PROCESS_ROLE: 'web',
      BASE_URL: 'http://localhost:3000',
    },
  },
});
