function setIfEmpty(key: string, value: string): void {
  const current = process.env[key];
  if (current === undefined || current === '') {
    process.env[key] = value;
  }
}

setIfEmpty('DATABASE_URL', 'postgres://localhost/test');
setIfEmpty('ANTHROPIC_API_KEY', 'sk-test');
setIfEmpty('CLICKUP_OAUTH_CLIENT_ID', 'test-id');
setIfEmpty('CLICKUP_OAUTH_CLIENT_SECRET', 'test-secret');
setIfEmpty('CLICKUP_WEBHOOK_SECRET', 'test-secret');
setIfEmpty('RESEND_API_KEY', 'test-rs');
setIfEmpty('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
setIfEmpty('SESSION_COOKIE_SECRET', 'b'.repeat(32));
setIfEmpty('PROCESS_ROLE', 'web');
setIfEmpty('BASE_URL', 'http://localhost:3000');
