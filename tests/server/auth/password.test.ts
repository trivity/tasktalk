import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/server/auth/password.js';

describe('password', () => {
  it('hashes and verifies the same password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
  });

  it('rejects wrong password', async () => {
    const h = await hashPassword('alpha');
    expect(await verifyPassword(h, 'beta')).toBe(false);
  });

  it('handles empty hash gracefully', async () => {
    expect(await verifyPassword(null, 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});
