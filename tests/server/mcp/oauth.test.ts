import { describe, it, expect } from 'vitest';
import { generatePkcePair, buildAuthorizeUrl } from '../../../src/server/mcp/oauth.js';

describe('OAuth PKCE', () => {
  it('generates a pair where challenge != verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeChallenge.length).toBeGreaterThan(20);
    expect(codeChallenge).not.toBe(codeVerifier);
  });

  it('produces deterministic challenge for known verifier (SHA256 base64url)', () => {
    // RFC 7636 example
    const known = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const { codeChallenge } = generatePkcePair(known);
    expect(codeChallenge).toBe(expected);
  });

  it('builds authorize URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'abc',
      redirectUri: 'https://app/callback',
      codeChallenge: 'xxx',
      state: 'st',
    });
    expect(url).toMatch(/client_id=abc/);
    expect(url).toMatch(/code_challenge=xxx/);
    expect(url).toMatch(/code_challenge_method=S256/);
    expect(url).toMatch(/state=st/);
    expect(url).toMatch(/response_type=code/);
  });
});
