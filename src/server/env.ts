import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CLICKUP_OAUTH_CLIENT_ID: z.string().min(1),
  CLICKUP_OAUTH_CLIENT_SECRET: z.string().min(1),
  CLICKUP_WEBHOOK_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, 'TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)'),
  SESSION_COOKIE_SECRET: z.string().min(32),
  SENTRY_DSN: z.string().optional(),
  PROCESS_ROLE: z.enum(['web', 'worker']),
  BASE_URL: z.string().url(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(
  raw: Record<string, string | undefined> = process.env,
): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

export const env = parseEnv();
