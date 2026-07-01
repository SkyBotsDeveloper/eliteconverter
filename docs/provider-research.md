# Provider Research

Research date: 2026-07-02.

## CloudConvert

- Official documentation: https://cloudconvert.com/api/v2 and
  https://cloudconvert.com/docs/api-reference/jobs.
- Server-side API use: documented through API v2 bearer-token authentication.
- Relevant API model: asynchronous jobs composed of tasks, including documented `import/url`,
  `convert` and `export/url` operations.
- Webhooks: documented CloudConvert webhooks with `CloudConvert-Signature` HMAC verification.
- Limits and pricing: CloudConvert documents sandbox mode and pricing/credits publicly, but actual
  production quotas depend on the account plan.
- Supported formats: CloudConvert documents broad file conversion support. EliteConverter enables
  only configured output formats for this adapter, defaulting to `mp4,webm,mkv`, and source-only
  quality because this adapter does not define provider-specific resolution presets.
- Integration result: added a dedicated opt-in `CloudConvertProvider`. It is disabled unless
  `ENABLED_PROVIDERS` includes `cloudconvert` and `CLOUDCONVERT_API_KEY` is supplied as a Worker
  secret.
- Verification status: only mocked adapter contract tests were run. No real authorized M3U8
  conversion was executed.

## ConvertAPI

- Official documentation: https://www.convertapi.com/doc and provider format pages under
  `https://www.convertapi.com/`.
- Server-side API use: documented API-token based conversion requests.
- Limits and pricing: documented publicly by ConvertAPI, with account-plan dependent quotas.
- Webhooks: ConvertAPI documents asynchronous conversion patterns, but this pass did not verify a
  full durable webhook/status contract that maps cleanly to EliteConverter's job model.
- Integration result: not integrated. The project should use a dedicated adapter only after the
  exact M3U8-to-target behavior, output URL lifetime and webhook/status semantics are verified from
  current official docs or a provider test account.

## Zamzar

- Official documentation: https://developers.zamzar.com/docs.
- Server-side API use: documented REST API with API-key authentication.
- Limits and pricing: documented publicly by Zamzar, with account-plan dependent quotas.
- Webhooks/status: documented job-based conversion API, but this pass did not confirm a provider
  output URL and webhook contract sufficient to implement and test a dedicated adapter here.
- Integration result: not integrated.

## Conclusion

CloudConvert has the clearest documented async job/task model for this repository's adapter shape,
so EliteConverter now includes a dedicated CloudConvert adapter. Real production conversion still
requires provider credentials, configured Cloudflare secrets and a permitted source URL test. Mock
mode remains for local development and automated tests.
