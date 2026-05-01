import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/server/claude/system-prompt.js';

describe('buildSystemPrompt', () => {
  it('includes user, workspace, and freshness', () => {
    const out = buildSystemPrompt({
      userName: 'Oz',
      userEmail: 'oz@travis.chat',
      workspaceName: 'Engineering',
      mirrorAsOf: new Date('2026-05-01T14:32:00Z'),
      taskCount: 42,
      now: new Date('2026-05-01T15:00:00Z'),
    });
    expect(out).toMatch(/Oz/);
    expect(out).toMatch(/Engineering/);
    expect(out).toMatch(/2026-05-01/);
    expect(out).toMatch(/42/);
  });

  it('includes named-person guardrail', () => {
    const out = buildSystemPrompt({
      userName: 'X', userEmail: 'x@y', workspaceName: 'W',
      mirrorAsOf: new Date(), taskCount: 0, now: new Date(),
    });
    expect(out.toLowerCase()).toContain('named-person');
  });
});
