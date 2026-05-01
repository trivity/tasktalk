import { config } from 'dotenv';

// Override is required because some env vars (e.g. ANTHROPIC_API_KEY) may be
// pre-set as empty strings at the OS / shell level on developer machines.
// Without override, dotenv leaves them as empty strings and zod validation
// fails. We want the local .env file to be the source of truth in dev.
config({ override: true });
