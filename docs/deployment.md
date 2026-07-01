# Cloudflare Deployment

## Local

1. Install dependencies: `corepack pnpm install --frozen-lockfile`.
2. Copy `.dev.vars.example` to `.dev.vars` and replace development secrets.
3. Run local D1 migrations: `corepack pnpm db:migrate:local`.
4. Start the API and frontend: `corepack pnpm dev`.

## Cloudflare Resources

Create these resources in the target Cloudflare account:

- D1 database named `eliteconverter`.
- Queue named `eliteconverter-conversions`.
- Turnstile site and secret keys.
- Workers Rate Limiting namespace if available on the account.

Update `wrangler.toml` environment blocks with the real D1 database IDs and queue names. Do not commit Cloudflare account IDs or secret values.

## Secrets

Set secrets with Wrangler:

```bash
corepack pnpm wrangler secret put API_KEY_HASH_SECRET
corepack pnpm wrangler secret put CLIENT_WEBHOOK_SIGNING_SECRET
corepack pnpm wrangler secret put TURNSTILE_SECRET_KEY
corepack pnpm wrangler secret put GENERIC_PROVIDER_API_KEY
corepack pnpm wrangler secret put GENERIC_PROVIDER_WEBHOOK_SECRET
```

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

## Rollback

Use Cloudflare Workers deployment history to roll back to the previous verified deployment. If schema changes are involved, prepare a forward migration that restores compatibility rather than deleting production data.
