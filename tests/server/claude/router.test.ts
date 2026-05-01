import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../../src/server/claude/router.js';

describe('Hybrid Router — query_tasks', () => {
  const FRESH = new Date(Date.now() - 60_000); // 1 min ago
  const STALE = new Date(Date.now() - 600_000); // 10 min ago

  it('snapshot when fresh', () => {
    expect(decideRoute({ lastSyncAt: FRESH, mirrorEmpty: false })).toBe('snapshot');
  });

  it('live when stale', () => {
    expect(decideRoute({ lastSyncAt: STALE, mirrorEmpty: false })).toBe('live');
  });

  it('live + first_run when mirror empty', () => {
    expect(decideRoute({ lastSyncAt: null, mirrorEmpty: true })).toBe('live-first-run');
  });
});
