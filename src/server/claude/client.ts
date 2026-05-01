import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const MAX_TURN_ITERATIONS = 8;
