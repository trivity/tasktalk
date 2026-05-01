import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../../../src/server/db/encrypt.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('encryptToken / decryptToken', () => {
  it('round-trips a token', () => {
    const cipher = encryptToken('my-secret-token', KEY);
    expect(cipher).not.toContain('my-secret-token');
    expect(decryptToken(cipher, KEY)).toBe('my-secret-token');
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const a = encryptToken('same', KEY);
    const b = encryptToken('same', KEY);
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', () => {
    const cipher = encryptToken('hi', KEY);
    const tampered = cipher.slice(0, -2) + 'XX';
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });
});
