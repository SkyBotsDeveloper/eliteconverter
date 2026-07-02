# Cloudflare Deployment

## Local

1. Install dependencies: `corepack pnpm install --frozen-lockfile`.
2. Copy `.dev.vars.example` to `.dev.vars` and replace development secrets.
3. Run local D1 migrations: `corepack pnpm db:migrate:local`.
4. Start the API and frontend: `corepack pnpm dev`.

## Cloudflare Resources

Create these resources separately in each target Cloudflare account/environment:

- Staging D1 database, for example `eliteconverter-staging`.
- Production D1 database, for example `eliteconverter-production`.
- Staging Queue, for example `eliteconverter-staging-conversions`.
- Staging dead-letter Queue, for example `eliteconverter-staging-conversions-dlq`.
- Production Queue, for example `eliteconverter-production-conversions`.
- Production dead-letter Queue, for example `eliteconverter-production-conversions-dlq`.
- Staging and production Turnstile site and secret keys.
- Staging and production Workers Rate Limiting namespaces if available on the account.

Update `wrangler.toml` environment blocks with the real D1 database IDs and queue names. Do not commit Cloudflare account IDs or secret values.

## Secrets

Set secrets with Wrangler:

```bash
corepack pnpm wrangler secret put API_KEY_HASH_SECRET
corepack pnpm wrangler secret put CLIENT_WEBHOOK_SIGNING_SECRET
corepack pnpm wrangler secret put TURNSTILE_SECRET_KEY
corepack pnpm wrangler secret put GENERIC_PROVIDER_API_KEY
corepack pnpm wrangler secret put GENERIC_PROVIDER_WEBHOOK_SECRET
corepack pnpm wrangler secret put CLOUDCONVERT_API_KEY
corepack pnpm wrangler secret put CLOUDCONVERT_WEBHOOK_SIGNING_SECRET
```

Run the same secret commands with `--env staging` and `--env production` and use different values
where the provider, Turnstile or webhook endpoint requires isolation. `wrangler.toml` includes
explicit staging and production binding blocks; do not rely on top-level bindings being inherited.

## Migrations

```bash
corepack pnpm db:migrate:production
```

## Deployment

```bash
corepack pnpm build
corepack pnpm deploy:staging
corepack pnpm deploy:production
```

Deployment is not complete until the Worker route, API health endpoint, static assets and queue consumer have been verified in the Cloudflare dashboard and through HTTP checks.

## Real Provider Verification

The real-provider integration test is skipped unless explicitly enabled. Supply a permitted,
non-DRM VOD playlist and provider credentials only through the process environment:

```bash
RUN_REAL_PROVIDER_TEST=1 \
REAL_PROVIDER_M3U8_URL="https://provider-authorized.example/test.m3u8" \
REAL_PROVIDER_BASE_URL="https://provider.example/api" \
REAL_PROVIDER_API_KEY="<secret>" \
REAL_PROVIDER_EXPECT_AUDIO=1 \
corepack pnpm test:integration
```

The harness waits for completion, validates every output redirect, requires an MP4 response with a
non-zero body and uses `ffprobe` to require a playable video stream (and audio when requested). It
does not print credentials, source URLs, signed output URLs or provider job payloads.

## Rollback

Use Cloudflare Workers deployment history to roll back to the previous verified deployment. If schema changes are involved, prepare a forward migration that restores compatibility rather than deleting production data.
