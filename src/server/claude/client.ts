import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';

/** @deprecated Use getAiClientForUser() from './get-client.js' instead. Kept for backward-compat only. */
export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** @deprecated Use DEFAULT_MODEL from './get-client.js' instead. Kept for backward-compat only. */
export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export const MAX_TURN_ITERATIONS = 8;
