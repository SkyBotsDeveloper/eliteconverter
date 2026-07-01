# Architecture Decisions

EliteConverter uses Cloudflare Workers as an API gateway and orchestration layer. It does not transcode video inside the Worker. Conversion is delegated to configured providers through adapters, with a deterministic mock provider for local development and tests.

## Researched Official References

- Cloudflare Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Wrangler configuration and commands: https://developers.cloudflare.com/workers/wrangler/configuration/
- Cloudflare Workers TypeScript support: https://developers.cloudflare.com/workers/languages/typescript/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- D1 local development: https://developers.cloudflare.com/d1/best-practices/local-development/
- Cloudflare Queues: https://developers.cloudflare.com/queues/get-started/
- Turnstile server-side validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cron Triggers and scheduled handlers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Hono on Cloudflare Workers: https://hono.dev/docs/getting-started/cloudflare-workers
- Vite guide: https://vite.dev/guide/
- React Router declarative installation: https://reactrouter.com/start/declarative/installation
- Tailwind CSS with Vite: https://tailwindcss.com/docs/installation/using-vite
- GitHub Actions workflow syntax: https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
- GitHub Actions secrets: https://docs.github.com/actions/security-guides/using-secrets-in-github-actions

## Decisions

1. Cloudflare Worker plus Static Assets serves the full stack from one deployable Worker. Workers Sites is intentionally avoided because the current Wrangler documentation directs new projects to Static Assets.
2. D1 is the durable source of truth for jobs, API keys, events, provider attempts, incidents and webhook deliveries. A memory repository is included only for tests and local demo behavior when Cloudflare bindings are unavailable.
3. Cloudflare Queues handles asynchronous conversion work. Local tests call the same processor directly so conversion behavior is deterministic without real Cloudflare resources.
4. Turnstile is enforced for anonymous conversion routes in production. Test and development modes accept documented mock tokens only.
5. Rate limiting uses the Workers Rate Limiting binding when present and falls back to an in-memory limiter for local tests.
6. Provider adapters are isolated from API routes. The mock adapter is the default provider, and Generic HTTP requires validated environment configuration before it can be enabled.
7. Webhooks use HMAC-SHA-256 signatures with timestamp tolerance and replay protection.
8. Signed source and output URLs are redacted in logs and UI by default.
9. Production deployment requires real D1 database IDs, queue names, Turnstile keys, secrets and provider credentials supplied through Cloudflare, not committed files.
