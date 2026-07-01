# Provider Adapters

Provider adapters implement the `ConversionProvider` interface from `@eliteconverter/shared`.

## Required Methods

- `getCapabilities()`
- `createJob(input, context)`
- `getJobStatus(providerJobId, context)`

Optional methods:

- `cancelJob(providerJobId, context)`
- `refreshDownloadUrl(providerJobId, context)`
- `verifyWebhook(request)`

## Rules

1. Keep provider-specific field names inside the adapter.
2. Validate all required configuration at startup.
3. Do not log raw provider secrets or complete signed URLs.
4. Return public error classifications instead of provider diagnostics.
5. Use provider idempotency features when available to prevent duplicate billing.
6. Validate provider output URLs before marking a job completed.

## Generic HTTP Provider

The generic provider is configured by environment variables:

- `GENERIC_PROVIDER_BASE_URL`
- `GENERIC_PROVIDER_API_KEY`
- `GENERIC_PROVIDER_AUTH_HEADER`
- `GENERIC_PROVIDER_AUTH_SCHEME`
- `GENERIC_PROVIDER_CREATE_PATH`
- `GENERIC_PROVIDER_STATUS_PATH`
- `GENERIC_PROVIDER_CANCEL_PATH`
- `GENERIC_PROVIDER_REFRESH_PATH`
- `GENERIC_PROVIDER_WEBHOOK_SECRET`
- `GENERIC_PROVIDER_TIMEOUT_MS`

The default field mapping expects:

- create response `id`
- status response `status`
- status response `progress`
- status response `output.url`

Use a dedicated adapter for providers with more complex or documented schemas.
