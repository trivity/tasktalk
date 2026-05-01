import { describe, it, expect } from 'vitest';
import { Pacer } from '../../../src/server/sync/pacing.js';

describe('Pacer', () => {
  it('allows immediate calls under capacity', async () => {
    const p = new Pacer({ ratePerSecond: 100, burst: 5 });
    const start = Date.now();
    for (let i = 0; i < 5; i++) await p.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks when capacity exceeded', async () => {
    const p = new Pacer({ ratePerSecond: 10, burst: 2 });
    const start = Date.now();
    await p.acquire(); await p.acquire(); await p.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});
