import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../../src/server/claude/router.js';

describe('Hybrid Router — query_tasks', () => {
  const ONE_MIN_AGO = new Date(Date.now() - 60_000);
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60_000);
  const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60_000);

  it('snapshot when fresh', () => {
    expect(decideRoute({ lastSyncAt: ONE_MIN_AGO, mirrorEmpty: false })).toBe('snapshot');
  });

  it('snapshot when within 24h freshness window (webhooks not assumed)', () => {
    expect(decideRoute({ lastSyncAt: ONE_HOUR_AGO, mirrorEmpty: false })).toBe('snapshot');
  });

  it('live when older than freshness threshold', () => {
    expect(decideRoute({ lastSyncAt: TWO_DAYS_AGO, mirrorEmpty: false })).toBe('live');
  });

  it('live + first_run when mirror empty', () => {
    expect(decideRoute({ lastSyncAt: null, mirrorEmpty: true })).toBe('live-first-run');
  });

  it('snapshot when sync stamp missing but mirror has data', () => {
    expect(decideRoute({ lastSyncAt: null, mirrorEmpty: false })).toBe('snapshot');
  });
});
