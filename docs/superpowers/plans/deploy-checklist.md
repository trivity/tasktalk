# Tasktalk Deploy Checklist (Railway)

## Pre-deploy

- [ ] ClickUp OAuth allowlist application filed (production redirect URI: https://<your-railway-url>/api/clickup/callback)
- [ ] Resend domain verified for noreply@<your-domain>
- [ ] Anthropic API key with sufficient quota
- [ ] CLICKUP_OAUTH_CLIENT_ID + SECRET obtained from ClickUp app registration
- [ ] CLICKUP_WEBHOOK_SECRET generated (32+ random bytes, hex-encoded)
- [ ] TOKEN_ENCRYPTION_KEY generated (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] SESSION_COOKIE_SECRET generated (>=32 chars)

## Railway setup

- [ ] Create project, connect GitHub repo
- [ ] Add Postgres service (managed)
- [ ] Add `tasktalk-web` service from Dockerfile, set PROCESS_ROLE=web
- [ ] Add `tasktalk-worker` service from same Dockerfile, set PROCESS_ROLE=worker
- [ ] Inject DATABASE_URL into both services from the Postgres service variables
- [ ] Set all env vars per `.env.example` in both services
- [ ] Set BASE_URL to Railway-generated public URL
- [ ] Run drizzle migrations: from local with prod DATABASE_URL: `npm run db:push`

## Post-deploy verification

- [ ] Hit `/api/health` on web service -> `{"ok":true,"role":"web"}`
- [ ] Sign in via magic link (check Resend dashboard for delivery)
- [ ] Connect ClickUp (allowlist must be approved)
- [ ] Initial sync completes; verify `cu_tasks` row count matches expectation
- [ ] Webhook fires when a task is updated in ClickUp; system event appears inline
- [ ] A query returns within P95 < 800ms on hot snapshot
- [ ] Write + confirm + undo flow works end to end
- [ ] Sentry receiving any caught errors

## Rollback plan

- [ ] Tag deploys in git: `git tag -a deploy-YYYY-MM-DD -m "..."`
- [ ] Railway "Rollback" -> previous deploy
- [ ] Migration rollbacks: `drizzle/<n>_*.sql` are forward-only; for schema rollback, write a new migration that reverses the change
