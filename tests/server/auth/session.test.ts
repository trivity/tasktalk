import { describe, it, expect } from 'vitest';
import { generateSessionId, hashSessionId, sessionExpiry } from '../../../src/server/auth/session.js';

describe('session helpers', () => {
  it('generates a unique session id (>=32 chars hex-ish)', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes session id deterministically', () => {
    const id = generateSessionId();
    expect(hashSessionId(id)).toBe(hashSessionId(id));
    expect(hashSessionId(id)).not.toBe(id);
  });

  it('expiry is 7 days from now ±1s', () => {
    const exp = sessionExpiry();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(exp.getTime() - expectedMs)).toBeLessThan(1000);
  });
});
