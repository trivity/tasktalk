import { randomBytes, createHash } from 'node:crypto';
import { env } from '../env.js';

const AUTHORIZE_URL = 'https://mcp.clickup.com/oauth/authorize';
const TOKEN_URL = 'https://mcp.clickup.com/oauth/token';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkcePair(verifierOverride?: string): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = verifierOverride ?? base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  if (params.scopes?.length) url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

export type ClickUpTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export async function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ClickUpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.CLICKUP_OAUTH_CLIENT_ID,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ClickUp token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ClickUpTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<ClickUpTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.CLICKUP_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ClickUp token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ClickUpTokenResponse;
}
