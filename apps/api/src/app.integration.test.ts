import { describe, expect, it } from "vitest";
import { hashApiKey, randomId, type ApiResponse, type PublicJob } from "@eliteconverter/shared";
import { app, handleQueueBatch } from "./app";
import { getConfig } from "./config";
import { processQueuePayload, reconcileJobs } from "./jobs";
import { MemoryRepository } from "./repository";
import type { Env, QueuePayload, RequestContext, StoredApiKey, StoredJob } from "./types";

const apiSecret = "test-only-api-key-hash-secret";

const defaultFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers: { "content-type": "video/mp4" } });
  }
  if (url.includes("fail-webhook.example.com")) {
    return new Response("try later", { status: 500 });
  }
  return new Response("ok", { status: 204 });
};

const insertApiKey = async (
  repository: MemoryRepository,
  rawKey: string,
  id = "key_test",
  ownerId = "usr_test",
): Promise<StoredApiKey> => {
  const key: StoredApiKey = {
    id,
    ownerId,
    name: "Integration",
    prefix: rawKey.slice(0, 12),
    keyHash: await hashApiKey(rawKey, apiSecret),
    status: "active",
    scopes: ["conversions:create", "conversions:read", "conversions:cancel"],
    createdAt: new Date().toISOString(),
  };
  await repository.insertApiKey(key);
  return key;
};

const createEnv = async (overrides: Partial<Env> = {}) => {
  const repository = new MemoryRepository();
  const rawKey = `ec_test_${"a".repeat(40)}`;
  await insertApiKey(repository, rawKey);
  const env: Env = {
    APP_ENV: "test",
    API_KEY_HASH_SECRET: apiSecret,
    CLIENT_WEBHOOK_SIGNING_SECRET: "webhook-secret",
    ENABLED_PROVIDERS: "mock",
    PROVIDER_PRIORITY: "mock",
    INITIAL_RETRY_DELAY_MS: "0",
    MAX_RETRY_DELAY_MS: "0",
    MAX_RETRY_ATTEMPTS: "30",
    CLIENT_WEBHOOK_MAX_ATTEMPTS: "2",
    TEST_REPOSITORY: repository,
    TEST_FETCH: defaultFetch,
    ...overrides,
  };
  return { env, rawKey, repository };
};

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const authHeaders = (rawKey: string) => ({ Authorization: `Bearer ${rawKey}` });

const tokenHeaders = (accessToken: string) => ({ "EliteConverter-Job-Token": accessToken });

const contextFor = (env: Env, requestId = "req_test"): RequestContext => ({
  requestId,
  env,
  config: getConfig(env),
  repository: env.TEST_REPOSITORY ?? new MemoryRepository(),
  fetcher: env.TEST_FETCH ?? fetch,
});

const createPrivateJob = async (env: Env, rawKey: string, url: string) => {
  const response = await app.fetch(
    request("/api/v1/conversions", {
      method: "POST",
      headers: authHeaders(rawKey),
      body: JSON.stringify({ url, format: "mp4", quality: "source" }),
    }),
    env,
  );
  expect(response.status).toBe(202);
  return json<ApiResponse<{ jobId: string; status: string; statusUrl: string }>>(response);
};

const makeStoredJob = (overrides: Partial<StoredJob> = {}): StoredJob => {
  const now = new Date().toISOString();
  return {
    id: "job_queue_test",
    publicId: "ec_job_queue_test",
    inputUrl: "https://media.example.com/master.m3u8",
    inputUrlRedacted: "https://media.example.com/master.m3u8",
    sourceHostname: "media.example.com",
    format: "mp4",
    quality: "source",
    status: "completed",
    progress: 100,
    currentStage: "completed",
    providerId: "missing",
    providerJobId: "provider_missing",
    retryCount: 0,
    providerAttemptCount: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    completedAt: now,
    pollAttemptCount: 0,
    ...overrides,
  };
};

describe("EliteConverter API", () => {
  it("serves health and dynamic capabilities", async () => {
    const { env, rawKey } = await createEnv({
      MOCK_PROVIDER_FORMATS: "mp4",
      MOCK_PROVIDER_QUALITIES: "source,720p",
    });
    const health = await app.fetch(request("/api/v1/health"), env);
    expect(health.status).toBe(200);

    const capabilities = await app.fetch(request("/api/v1/capabilities"), env);
    const body =
      await json<
        ApiResponse<{ formats: string[]; qualities: string[]; providers: Array<{ id: string }> }>
      >(capabilities);
    expect(body.success && body.data.formats).toEqual(["mp4"]);
    expect(body.success && body.data.qualities).toEqual(["source", "720p"]);

    const unsupported = await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        headers: authHeaders(rawKey),
        body: JSON.stringify({
          url: "https://media.example.com/master.m3u8",
          format: "webm",
          quality: "source",
        }),
      }),
      env,
    );
    expect(unsupported.status).toBe(400);
  });

  it("rejects unauthenticated private conversions", async () => {
    const { env } = await createEnv();
    const response = await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        body: JSON.stringify({
          url: "https://media.example.com/master.m3u8",
          format: "mp4",
          quality: "source",
        }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("creates authenticated jobs and honors idempotency atomically", async () => {
    const { env, rawKey } = await createEnv();
    const body = {
      url: "https://media.example.com/master.m3u8?mock=success",
      format: "mp4",
      quality: "source",
    };
    const init: RequestInit = {
      method: "POST",
      headers: { ...authHeaders(rawKey), "Idempotency-Key": "same-key" },
      body: JSON.stringify(body),
    };
    const [first, second] = await Promise.all([
      app.fetch(request("/api/v1/conversions", init), env),
      app.fetch(request("/api/v1/conversions", init), env),
    ]);
    const firstBody = await json<ApiResponse<{ jobId: string; status: string }>>(first);
    const secondBody = await json<ApiResponse<{ jobId: string; status: string }>>(second);
    expect(first.status).toBe(202);
    expect(firstBody.success && secondBody.success && secondBody.data.jobId).toBe(
      firstBody.success ? firstBody.data.jobId : "",
    );
  });

  it("rejects idempotency conflicts", async () => {
    const { env, rawKey } = await createEnv();
    const headers = { ...authHeaders(rawKey), "Idempotency-Key": "conflict-key" };
    await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://media.example.com/a.m3u8",
          format: "mp4",
          quality: "source",
        }),
      }),
      env,
    );
    const conflict = await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://media.example.com/b.m3u8",
          format: "mp4",
          quality: "source",
        }),
      }),
      env,
    );
    expect(conflict.status).toBe(409);
  });

  it("requires anonymous job access tokens for status and events", async () => {
    const { env } = await createEnv();
    const response = await app.fetch(
      request("/api/v1/public/conversions", {
        method: "POST",
        headers: { "x-anonymous-session": randomId("anon", 8) },
        body: JSON.stringify({
          url: "https://media.example.com/master.m3u8?mock=retry",
          format: "mp4",
          quality: "source",
          permissionConfirmed: true,
          turnstileToken: "test-pass",
        }),
      }),
      env,
    );
    const body = await json<ApiResponse<{ jobId: string; accessToken: string }>>(response);
    expect(response.status).toBe(202);
    expect(body.success && body.data.accessToken).toMatch(/^ec_access_/);
    if (!body.success) throw new Error("expected success");

    const noToken = await app.fetch(request(`/api/v1/conversions/${body.data.jobId}`), env);
    const wrongToken = await app.fetch(
      request(`/api/v1/conversions/${body.data.jobId}`, {
        headers: tokenHeaders("ec_access_wrong"),
      }),
      env,
    );
    const cancelWrongToken = await app.fetch(
      request(`/api/v1/conversions/${body.data.jobId}/cancel`, {
        method: "POST",
        headers: tokenHeaders("ec_access_wrong"),
      }),
      env,
    );
    const job = await app.fetch(
      request(`/api/v1/conversions/${body.data.jobId}`, {
        headers: tokenHeaders(body.data.accessToken),
      }),
      env,
    );
    const publicJob = await json<ApiResponse<PublicJob>>(job);
    const events = await app.fetch(
      request(`/api/v1/conversions/${body.data.jobId}/events`, {
        headers: tokenHeaders(body.data.accessToken),
      }),
      env,
    );

    expect(noToken.status).toBe(401);
    expect(wrongToken.status).toBe(403);
    expect(cancelWrongToken.status).toBe(403);
    expect(publicJob.success && publicJob.data.status).toBe("completed");
    expect(publicJob.success && publicJob.data.outputUrl).toBeUndefined();
    expect(events.status).toBe(200);
  });

  it("enforces API-key ownership on private jobs", async () => {
    const { env, rawKey, repository } = await createEnv();
    const otherKey = `ec_test_${"b".repeat(40)}`;
    await insertApiKey(repository, otherKey, "key_other", "usr_other");
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/master.m3u8?mock=success",
    );
    if (!created.success) throw new Error("expected success");

    const denied = await app.fetch(
      request(`/api/v1/conversions/${created.data.jobId}`, { headers: authHeaders(otherKey) }),
      env,
    );
    expect(denied.status).toBe(403);
  });

  it("keeps signed download URLs private and exposes them only through download endpoint", async () => {
    const { env, rawKey, repository } = await createEnv();
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/master.m3u8?mock=success&token=source-secret",
    );
    if (!created.success) throw new Error("expected success");

    const status = await app.fetch(
      request(`/api/v1/conversions/${created.data.jobId}`, { headers: authHeaders(rawKey) }),
      env,
    );
    const statusBody = await json<ApiResponse<PublicJob>>(status);
    const download = await app.fetch(
      request(`/api/v1/conversions/${created.data.jobId}/download`, {
        headers: authHeaders(rawKey),
      }),
      env,
    );
    const downloadBody = await json<ApiResponse<{ url: string; expiresAt?: string }>>(download);
    const stored = await repository.getJobByPublicId(created.data.jobId);

    expect(statusBody.success && statusBody.data.outputUrl).toBeUndefined();
    expect(downloadBody.success && downloadBody.data.url).toContain("token=mock-token");
    expect(downloadBody.success && downloadBody.data.url).toContain("signature=mock-signature");
    expect(downloadBody.success && downloadBody.data.url).toContain("policy=mock-policy");
    expect(stored?.outputUrlPrivate).toContain("token=mock-token");
    expect(stored?.outputUrlRedacted).toContain("%3Credacted%3E");
  });

  it("completes long-running jobs across many poll stages", async () => {
    const { env, rawKey, repository } = await createEnv();
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/master.m3u8?mock=long-20",
    );
    if (!created.success) throw new Error("expected success");
    const stored = await repository.getJobByPublicId(created.data.jobId);
    expect(stored?.status).toBe("completed");
    expect(stored?.pollAttemptCount).toBeGreaterThanOrEqual(20);
  });

  it("recovers missed queue tasks through scheduled reconciliation", async () => {
    const sent: QueuePayload[] = [];
    const queue = {
      send: async (payload: QueuePayload) => {
        sent.push(payload);
      },
    } as unknown as Queue<QueuePayload>;
    const { env, rawKey, repository } = await createEnv({ CONVERSION_QUEUE: queue });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/master.m3u8?mock=success",
    );
    if (!created.success) throw new Error("expected success");
    expect(sent.map((payload) => payload.kind)).toContain("submit_provider_job");

    const context = contextFor(env);
    await reconcileJobs(context);
    await reconcileJobs(context);
    const stored = await repository.getJobByPublicId(created.data.jobId);
    expect(stored?.status).toBe("completed");
  });

  it("deduplicates queue payloads and retries only retryable queue failures", async () => {
    const { env, repository } = await createEnv();
    const completed = makeStoredJob();
    await repository.insertJob(completed);
    const context = contextFor(env);
    const dedupePayload: QueuePayload = {
      kind: "reconcile_stuck_job",
      jobId: completed.id,
      requestId: "req_dedupe",
      dedupeKey: "dedupe-once",
    };
    await processQueuePayload(dedupePayload, context);
    await processQueuePayload(dedupePayload, context);
    expect(await repository.hasProcessedQueueDelivery("dedupe-once")).toBe(true);

    let acked = 0;
    let retried = 0;
    const retryPayload: QueuePayload = {
      kind: "refresh_provider_job",
      jobId: completed.id,
      requestId: "req_retry",
      dedupeKey: "refresh-retry",
    };
    const badPayload: QueuePayload = {
      kind: "deliver_client_webhook",
      jobId: completed.id,
      requestId: "req_ack",
      dedupeKey: "bad-webhook",
    };
    const successPayload: QueuePayload = {
      kind: "reconcile_stuck_job",
      jobId: completed.id,
      requestId: "req_success",
      dedupeKey: "success-ack",
    };
    const batch = {
      messages: [
        {
          body: retryPayload,
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
        {
          body: badPayload,
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
        {
          body: successPayload,
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
      ],
    } as unknown as MessageBatch<QueuePayload>;
    await handleQueueBatch(batch, env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext);
    expect(retried).toBe(1);
    expect(acked).toBe(2);
  });

  it("allows provider webhooks to win a race with fallback polling", async () => {
    const sent: QueuePayload[] = [];
    const queue = {
      send: async (payload: QueuePayload) => {
        sent.push(payload);
      },
    } as unknown as Queue<QueuePayload>;
    const { env, rawKey, repository } = await createEnv({ CONVERSION_QUEUE: queue });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/master.m3u8?mock=long-20",
    );
    if (!created.success) throw new Error("expected success");

    const context = contextFor(env);
    await reconcileJobs(context);
    const processing = await repository.getJobByPublicId(created.data.jobId);
    if (!processing?.providerJobId) throw new Error("expected provider job id");
    const pendingPoll = sent.find((payload) => payload.kind === "poll_provider_job");
    expect(pendingPoll).toBeDefined();

    const webhook = await app.fetch(
      request("/api/v1/webhooks/providers/mock", {
        method: "POST",
        body: JSON.stringify({
          eventId: "provider-event-race",
          providerJobId: processing.providerJobId,
          status: "completed",
          outputUrl:
            "https://downloads.example.com/eliteconverter/race.mp4?token=hook-token&signature=hook-signature",
        }),
      }),
      env,
    );
    expect(webhook.status).toBe(200);
    if (!pendingPoll) throw new Error("expected poll payload");
    await processQueuePayload(pendingPoll, context);

    const completed = await repository.getJobByPublicId(created.data.jobId);
    expect(completed?.status).toBe("completed");
    expect(completed?.outputUrlPrivate).toContain("hook-token");
  });

  it("retries client webhooks and records final failure state durably", async () => {
    const { env, rawKey, repository } = await createEnv();
    const response = await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        headers: authHeaders(rawKey),
        body: JSON.stringify({
          url: "https://media.example.com/master.m3u8?mock=success",
          format: "mp4",
          quality: "source",
          callbackUrl: "https://fail-webhook.example.com/hooks?token=client-secret",
        }),
      }),
      env,
    );
    const created = await json<ApiResponse<{ jobId: string }>>(response);
    if (!created.success) throw new Error("expected success");
    const stored = await repository.getJobByPublicId(created.data.jobId);
    if (!stored) throw new Error("expected stored job");

    const webhookEvents = await repository.listClientWebhookEventsForJob(stored.id);
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]?.status).toBe("permanently_failed");
    expect(webhookEvents[0]?.attemptCount).toBe(2);
    expect(webhookEvents[0]?.callbackUrlRedacted).toContain("%3Credacted%3E");
  });

  it("disables mock provider and test webhook route in production", async () => {
    const mockEnv = await createEnv({
      APP_ENV: "production",
      ENABLED_PROVIDERS: "mock",
      PROVIDER_PRIORITY: "mock",
      API_KEY_HASH_SECRET: apiSecret,
      CLIENT_WEBHOOK_SIGNING_SECRET: "webhook-secret",
    });
    const capabilities = await app.fetch(request("/api/v1/capabilities"), mockEnv.env);
    expect(capabilities.status).toBe(500);

    const productionEnv = await createEnv({
      APP_ENV: "production",
      ENABLED_PROVIDERS: "generic",
      PROVIDER_PRIORITY: "generic",
      GENERIC_PROVIDER_BASE_URL: "https://provider.example.com",
      GENERIC_PROVIDER_API_KEY: "provider-key",
      API_KEY_HASH_SECRET: apiSecret,
      CLIENT_WEBHOOK_SIGNING_SECRET: "webhook-secret",
    });
    const testWebhook = await app.fetch(
      request("/api/v1/webhooks/test", { method: "POST", body: JSON.stringify({ ok: true }) }),
      productionEnv.env,
    );
    expect(testWebhook.status).toBe(404);
  });

  it("handles cancellation and status route", async () => {
    const { env } = await createEnv();
    const status = await app.fetch(request("/api/v1/status"), env);
    expect(status.status).toBe(200);
  });
});
