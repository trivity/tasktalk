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
