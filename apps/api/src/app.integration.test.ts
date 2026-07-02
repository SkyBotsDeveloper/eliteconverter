import { describe, expect, it } from "vitest";
import { hashApiKey, randomId, type ApiResponse, type PublicJob } from "@eliteconverter/shared";
import { app, handleQueueBatch } from "./app";
import { getConfig } from "./config";
import {
  cancelStoredJob,
  processQueuePayload,
  reconcileJobs,
  refreshDownloadByInternalId,
} from "./jobs";
import { MemoryRepository } from "./repository";
import type {
  ClientWebhookEvent,
  Env,
  QueuePayload,
  RequestContext,
  ScheduledTask,
  StoredApiKey,
  StoredJob,
} from "./types";

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

const makeWebhookEvent = (
  jobId: string,
  eventId: string,
  callbackUrlPrivate: string,
  overrides: Partial<ClientWebhookEvent> = {},
): ClientWebhookEvent => {
  const now = new Date().toISOString();
  return {
    id: `cwe_${eventId}`,
    jobId,
    eventId,
    eventType: "conversion.completed",
    payloadJson: JSON.stringify({ id: eventId, type: "conversion.completed" }),
    callbackUrlPrivate,
    callbackUrlRedacted: callbackUrlPrivate,
    status: "pending",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const processWebhookEvent = async (
  event: ClientWebhookEvent,
  env: Env,
  repository: MemoryRepository,
) => {
  await repository.createClientWebhookEvent(event);
  await processQueuePayload(
    {
      kind: "deliver_client_webhook",
      jobId: event.jobId,
      requestId: `req_${event.eventId}`,
      dedupeKey: `${event.jobId}:deliver_client_webhook:${event.eventId}:${event.attemptCount}`,
      webhookEventId: event.eventId,
    },
    contextFor(env),
  );
  return repository.getClientWebhookEvent(event.eventId);
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

  it("does not accept M3U8 through an unverified generic provider", async () => {
    const { env, rawKey } = await createEnv({
      ENABLED_PROVIDERS: "generic",
      PROVIDER_PRIORITY: "generic",
      GENERIC_PROVIDER_BASE_URL: "https://provider.example.com",
      GENERIC_PROVIDER_API_KEY: "provider-key",
    });
    const response = await app.fetch(
      request("/api/v1/conversions", {
        method: "POST",
        headers: authHeaders(rawKey),
        body: JSON.stringify({
          url: "https://media.example.com/master.m3u8",
          format: "mp4",
          quality: "source",
        }),
      }),
      env,
    );
    const body = await json<ApiResponse<unknown>>(response);
    expect(response.status).toBe(400);
    expect(!body.success && body.error.code).toBe("unsupported_source");
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
    expect((await repository.getQueueDelivery("dedupe-once"))?.status).toBe("completed");

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

  it("retries unexpected queue exceptions instead of acknowledging them", async () => {
    const { env, repository } = await createEnv();
    const completed = makeStoredJob();
    await repository.insertJob(completed);
    repository.getJobById = async () => {
      throw new Error("unexpected repository failure");
    };

    let acked = 0;
    let retried = 0;
    const payload: QueuePayload = {
      kind: "reconcile_stuck_job",
      jobId: completed.id,
      requestId: "req_unexpected",
      dedupeKey: "unexpected-retry",
    };
    await handleQueueBatch(
      {
        messages: [
          {
            body: payload,
            ack: () => {
              acked += 1;
            },
            retry: () => {
              retried += 1;
            },
          },
        ],
      } as unknown as MessageBatch<QueuePayload>,
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext,
    );

    expect(acked).toBe(0);
    expect(retried).toBe(1);
    expect(await repository.getQueueDelivery(payload.dedupeKey)).toMatchObject({
      status: "pending",
      attemptCount: 1,
    });
  });

  it("records an exhausted queue failure before acknowledging it", async () => {
    const { env, repository } = await createEnv({ QUEUE_MAX_DELIVERY_ATTEMPTS: "2" });
    const active = makeStoredJob({
      id: "job_exhausted_queue",
      publicId: "ec_job_exhausted_queue",
      status: "processing",
      completedAt: undefined,
      providerId: undefined,
      providerJobId: undefined,
    });
    await repository.insertJob(active);
    const payload: QueuePayload = {
      kind: "refresh_provider_job",
      jobId: active.id,
      requestId: "req_exhausted_queue",
      dedupeKey: "exhausted-queue",
    };
    let acked = 0;
    let retried = 0;
    const deliver = () =>
      handleQueueBatch(
        {
          messages: [
            {
              body: payload,
              ack: () => {
                acked += 1;
              },
              retry: () => {
                retried += 1;
              },
            },
          ],
        } as unknown as MessageBatch<QueuePayload>,
        env,
        {
          waitUntil: () => undefined,
          passThroughOnException: () => undefined,
        } as unknown as ExecutionContext,
      );

    await deliver();
    await deliver();
    expect({ acked, retried }).toEqual({ acked: 1, retried: 1 });
    expect(await repository.getQueueDelivery(payload.dedupeKey)).toMatchObject({
      status: "failed",
      attemptCount: 2,
    });
    expect(await repository.getJobById(active.id)).toMatchObject({
      status: "failed",
      publicErrorCode: "output_unavailable",
    });
  });

  it("atomically claims concurrent duplicate queue messages", async () => {
    const { env, repository } = await createEnv();
    const queued = makeStoredJob({
      id: "job_atomic_queue",
      publicId: "ec_job_atomic_queue",
      status: "queued",
      progress: 0,
      currentStage: "queued",
      providerId: undefined,
      providerJobId: undefined,
      providerAttemptCount: 0,
      completedAt: undefined,
      outputUrlPrivate: undefined,
    });
    await repository.insertJob(queued);
    const payload: QueuePayload = {
      kind: "submit_provider_job",
      jobId: queued.id,
      requestId: "req_atomic_queue",
      dedupeKey: "atomic-queue-claim",
    };

    const results = await Promise.all([
      processQueuePayload(payload, contextFor(env), "lease_one"),
      processQueuePayload(payload, contextFor(env), "lease_two"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["completed", "retry_later"]);
    expect(await repository.listProviderAttempts(queued.id)).toHaveLength(1);
    expect(await repository.getQueueDelivery(payload.dedupeKey)).toMatchObject({
      status: "completed",
      attemptCount: 1,
    });
  });

  it("recovers an expired queue delivery lease", async () => {
    const { env, repository } = await createEnv();
    const completed = makeStoredJob({ id: "job_expired_queue_lease" });
    await repository.insertJob(completed);
    const payload: QueuePayload = {
      kind: "reconcile_stuck_job",
      jobId: completed.id,
      requestId: "req_expired_queue_lease",
      dedupeKey: "expired-queue-lease",
    };
    await repository.claimQueueDelivery({
      dedupeKey: payload.dedupeKey,
      leaseOwner: "crashed-worker",
      now: "2020-01-01T00:00:00.000Z",
      leaseExpiresAt: "2020-01-01T00:01:00.000Z",
      maxAttempts: 5,
    });

    await expect(
      processQueuePayload(payload, contextFor(env), "recovery-worker"),
    ).resolves.toMatchObject({ status: "completed" });
    expect(await repository.getQueueDelivery(payload.dedupeKey)).toMatchObject({
      status: "completed",
      attemptCount: 2,
    });
  });

  it("atomically claims scheduled tasks and recovers expired leases", async () => {
    const { repository } = await createEnv();
    const task: ScheduledTask = {
      id: "task_atomic",
      kind: "reconcile_stuck_job",
      jobId: "job_atomic",
      payload: {
        kind: "reconcile_stuck_job",
        jobId: "job_atomic",
        requestId: "req_atomic",
        dedupeKey: "task-atomic-claim",
      },
      runAt: "2020-01-01T00:00:00.000Z",
      status: "pending",
      attempts: 0,
      dedupeKey: "task-atomic-claim",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    await repository.scheduleTask(task);

    const [first, second] = await Promise.all([
      repository.claimDueScheduledTasks(
        "2020-01-01T00:00:01.000Z",
        10,
        "scheduler-one",
        "2020-01-01T00:01:00.000Z",
      ),
      repository.claimDueScheduledTasks(
        "2020-01-01T00:00:01.000Z",
        10,
        "scheduler-two",
        "2020-01-01T00:01:00.000Z",
      ),
    ]);
    expect(first.length + second.length).toBe(1);

    const recovered = await repository.claimDueScheduledTasks(
      "2020-01-01T00:02:00.000Z",
      10,
      "scheduler-recovery",
      "2020-01-01T00:03:00.000Z",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ leaseOwner: "scheduler-recovery", attempts: 2 });
  });

  it("recovers a webhook left delivering after a worker crash", async () => {
    let deliveredEventId = "";
    const fetcher: typeof fetch = async (_input, init) => {
      deliveredEventId = new Headers(init?.headers).get("EliteConverter-Event-Id") ?? "";
      return new Response(null, { status: 204 });
    };
    const { env, repository } = await createEnv({
      TEST_FETCH: fetcher,
      CLIENT_WEBHOOK_MAX_ATTEMPTS: "3",
    });
    const job = makeStoredJob({ id: "job_stale_webhook" });
    await repository.insertJob(job);
    const event = makeWebhookEvent(
      job.id,
      "evt_stale_delivery",
      "https://callbacks.example.com/hook",
      {
        status: "delivering",
        attemptCount: 1,
        leaseOwner: "crashed-worker",
        leaseExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    );

    const recovered = await processWebhookEvent(event, env, repository);
    expect(recovered).toMatchObject({ status: "delivered", attemptCount: 2 });
    expect(recovered?.leaseOwner).toBeUndefined();
    expect(deliveredEventId).toBe(event.eventId);
  });

  it.each([
    {
      name: "public redirect to private IP",
      callbackUrl: "https://callbacks.example.com/private",
      response: () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/hook" } }),
      expected: "permanently_failed",
    },
    {
      name: "redirect loop",
      callbackUrl: "https://callbacks.example.com/loop",
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://callbacks.example.com/loop" },
        }),
      expected: "permanently_failed",
    },
    {
      name: "missing Location",
      callbackUrl: "https://callbacks.example.com/missing",
      response: () => new Response(null, { status: 302 }),
      expected: "permanently_failed",
    },
  ])("rejects callback $name", async ({ callbackUrl, response, expected }) => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return response();
    };
    const { env, repository } = await createEnv({
      TEST_FETCH: fetcher,
      CLIENT_WEBHOOK_MAX_ATTEMPTS: "1",
    });
    const job = makeStoredJob({ id: `job_${callbackUrl.split("/").at(-1)}` });
    await repository.insertJob(job);
    const event = makeWebhookEvent(job.id, `evt_${job.id}`, callbackUrl);
    expect(await processWebhookEvent(event, env, repository)).toMatchObject({
      status: expected,
      attemptCount: 1,
    });
  });

  it("enforces callback redirect limit and accepts relative and public redirects", async () => {
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      expect(init?.redirect).toBe("manual");
      const url = String(input);
      requested.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/too-many/")) {
        const hop = Number(parsed.pathname.split("/").at(-1));
        return new Response(null, {
          status: 302,
          headers: { location: `/too-many/${hop + 1}` },
        });
      }
      if (parsed.pathname === "/relative") {
        return new Response(null, { status: 302, headers: { location: "/relative-target" } });
      }
      if (parsed.pathname === "/public") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://redirect.example.net/final" },
        });
      }
      return new Response(null, { status: 204 });
    };
    const { env, repository } = await createEnv({
      TEST_FETCH: fetcher,
      CLIENT_WEBHOOK_MAX_ATTEMPTS: "1",
    });
    const job = makeStoredJob({ id: "job_redirect_cases" });
    await repository.insertJob(job);

    const tooMany = await processWebhookEvent(
      makeWebhookEvent(job.id, "evt_too_many", "https://callbacks.example.com/too-many/0"),
      env,
      repository,
    );
    const relative = await processWebhookEvent(
      makeWebhookEvent(job.id, "evt_relative", "https://callbacks.example.com/relative"),
      env,
      repository,
    );
    const publicRedirect = await processWebhookEvent(
      makeWebhookEvent(job.id, "evt_public", "https://callbacks.example.com/public"),
      env,
      repository,
    );

    expect(tooMany?.status).toBe("permanently_failed");
    expect(relative?.status).toBe("delivered");
    expect(publicRedirect?.status).toBe("delivered");
    expect(requested).toContain("https://callbacks.example.com/relative-target");
    expect(requested).toContain("https://redirect.example.net/final");
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

  it("falls back after an accepted provider later fails", async () => {
    const { env, rawKey, repository } = await createEnv({
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "3",
      MAX_RETRY_ATTEMPTS: "0",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=async-fail&mock-b=success",
    );
    if (!created.success) throw new Error("expected success");

    const job = await repository.getJobByPublicId(created.data.jobId);
    if (!job) throw new Error("expected job");
    const attempts = await repository.listProviderAttempts(job.id);
    const events = await repository.listJobEvents(job.id);
    expect(job).toMatchObject({ status: "completed", providerId: "mock-b" });
    expect(attempts.map((attempt) => [attempt.providerId, attempt.status])).toEqual([
      ["mock-a", "failed"],
      ["mock-b", "completed"],
    ]);
    expect(events.map((event) => event.type)).toContain("conversion.provider_fallback");
  });

  it("limits same-provider retries before selecting the fallback provider", async () => {
    const { env, rawKey, repository } = await createEnv({
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "3",
      MAX_RETRY_ATTEMPTS: "1",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=async-fail&mock-b=success",
    );
    if (!created.success) throw new Error("expected success");
    const job = await repository.getJobByPublicId(created.data.jobId);
    if (!job) throw new Error("expected job");
    const attempts = await repository.listProviderAttempts(job.id);
    const events = await repository.listJobEvents(job.id);

    expect(attempts.map((attempt) => attempt.providerId)).toEqual(["mock-a", "mock-a", "mock-b"]);
    expect(events.map((event) => event.type)).toContain("conversion.provider_retry");
    expect(job).toMatchObject({ status: "completed", providerId: "mock-b" });
  });

  it("does not fall back for permanent asynchronous provider errors", async () => {
    const { env, rawKey, repository } = await createEnv({
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "3",
      MAX_RETRY_ATTEMPTS: "1",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=permanent&mock-b=success",
    );
    if (!created.success) throw new Error("expected success");
    const job = await repository.getJobByPublicId(created.data.jobId);
    if (!job) throw new Error("expected job");

    expect(job.status).toBe("failed");
    expect(
      (await repository.listProviderAttempts(job.id)).map((attempt) => attempt.providerId),
    ).toEqual(["mock-a"]);
  });

  it("fails cleanly when all asynchronous fallback providers are exhausted", async () => {
    const { env, rawKey, repository } = await createEnv({
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "2",
      MAX_RETRY_ATTEMPTS: "0",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=async-fail&mock-b=async-fail",
    );
    if (!created.success) throw new Error("expected success");

    const job = await repository.getJobByPublicId(created.data.jobId);
    if (!job) throw new Error("expected job");
    expect(job.status).toBe("failed");
    expect(await repository.listProviderAttempts(job.id)).toHaveLength(2);
  });

  it("does not submit a fallback provider after cancellation", async () => {
    const sent: QueuePayload[] = [];
    const queue = {
      send: async (payload: QueuePayload) => {
        sent.push(payload);
      },
    } as unknown as Queue<QueuePayload>;
    const { env, rawKey, repository } = await createEnv({
      CONVERSION_QUEUE: queue,
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "3",
      MAX_RETRY_ATTEMPTS: "0",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=async-fail&mock-b=success",
    );
    if (!created.success) throw new Error("expected success");
    const context = contextFor(env);
    const submit = sent.find((payload) => payload.kind === "submit_provider_job");
    if (!submit) throw new Error("expected submit");
    await processQueuePayload(submit, context);
    const poll = sent.find((payload) => payload.kind === "poll_provider_job");
    if (!poll) throw new Error("expected poll");
    await processQueuePayload(poll, context);
    const fallback = sent.find(
      (payload) => payload.kind === "submit_provider_job" && payload.dedupeKey.includes("fallback"),
    );
    if (!fallback) throw new Error("expected fallback");

    const beforeCancel = await repository.getJobByPublicId(created.data.jobId);
    if (!beforeCancel) throw new Error("expected job");
    await cancelStoredJob(beforeCancel, context);
    await processQueuePayload(fallback, context);

    const cancelled = await repository.getJobById(beforeCancel.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(
      (await repository.listProviderAttempts(beforeCancel.id)).map((item) => item.providerId),
    ).toEqual(["mock-a"]);
  });

  it("deduplicates a provider webhook and poll race during fallback", async () => {
    const sent: QueuePayload[] = [];
    const queue = {
      send: async (payload: QueuePayload) => {
        sent.push(payload);
      },
    } as unknown as Queue<QueuePayload>;
    const { env, rawKey, repository } = await createEnv({
      CONVERSION_QUEUE: queue,
      ENABLED_PROVIDERS: "mock-a,mock-b",
      PROVIDER_PRIORITY: "mock-a,mock-b",
      MAX_PROVIDER_ATTEMPTS: "3",
      MAX_RETRY_ATTEMPTS: "0",
    });
    const created = await createPrivateJob(
      env,
      rawKey,
      "https://media.example.com/input.m3u8?mock-a=async-fail&mock-b=success",
    );
    if (!created.success) throw new Error("expected success");
    const context = contextFor(env);
    const submit = sent.find((payload) => payload.kind === "submit_provider_job");
    if (!submit) throw new Error("expected submit");
    await processQueuePayload(submit, context);
    const processing = await repository.getJobByPublicId(created.data.jobId);
    const poll = sent.find((payload) => payload.kind === "poll_provider_job");
    if (!processing?.providerJobId || !poll) throw new Error("expected active provider job");

    await Promise.all([
      processQueuePayload(poll, context),
      app.fetch(
        request("/api/v1/webhooks/providers/mock-a", {
          method: "POST",
          body: JSON.stringify({
            eventId: "evt_fallback_race",
            providerJobId: processing.providerJobId,
            status: "failed",
            errorCode: "provider_temporary_failure",
            retryable: true,
          }),
        }),
        env,
      ),
    ]);
    const fallbacks = sent.filter(
      (payload) => payload.kind === "submit_provider_job" && payload.dedupeKey.includes("fallback"),
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    await Promise.all(
      fallbacks.map((payload, index) =>
        processQueuePayload(payload, context, `fallback-race-${index}`),
      ),
    );
    const fallbackPoll = [...sent]
      .reverse()
      .find(
        (payload) => payload.kind === "poll_provider_job" && payload.dedupeKey !== poll.dedupeKey,
      );
    if (!fallbackPoll) throw new Error("expected fallback poll");
    await processQueuePayload(fallbackPoll, context);

    const completed = await repository.getJobById(processing.id);
    const attempts = await repository.listProviderAttempts(processing.id);
    expect(completed).toMatchObject({ status: "completed", providerId: "mock-b" });
    expect(attempts.filter((attempt) => attempt.providerId === "mock-b")).toHaveLength(1);
  });

  it("returns an existing valid download and genuinely refreshes an expired one", async () => {
    const { env, repository } = await createEnv();
    const valid = makeStoredJob({
      id: "job_valid_download",
      providerId: "mock",
      providerJobId: "mock_valid",
      outputUrlPrivate: "https://downloads.example.com/current.mp4?token=current",
      outputUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      outputMimeType: "video/mp4",
    });
    const expired = makeStoredJob({
      id: "job_expired_download",
      publicId: "ec_job_expired_download",
      providerId: "mock",
      providerJobId: "mock_expired",
      outputUrlPrivate: "https://downloads.example.com/expired.mp4?token=expired",
      outputUrlExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      outputMimeType: "video/mp4",
    });
    await repository.insertJob(valid);
    await repository.insertJob(expired);

    const unchanged = await refreshDownloadByInternalId(valid.id, contextFor(env));
    const refreshed = await refreshDownloadByInternalId(expired.id, contextFor(env));
    expect(unchanged.outputUrlPrivate).toBe(valid.outputUrlPrivate);
    expect(refreshed.outputUrlPrivate).not.toBe(expired.outputUrlPrivate);
    expect(refreshed.outputUrlPrivate).toContain("mock_expired");
    expect(refreshed.outputUrlRedacted).toContain("%3Credacted%3E");
  });

  it("returns output_expired when a provider cannot regenerate a download", async () => {
    const { env, repository } = await createEnv({
      ENABLED_PROVIDERS: "generic",
      PROVIDER_PRIORITY: "generic",
      GENERIC_PROVIDER_BASE_URL: "https://provider.example.com",
      GENERIC_PROVIDER_API_KEY: "provider-key",
      GENERIC_PROVIDER_REFRESH_PATH: "",
    });
    const expired = makeStoredJob({
      id: "job_no_refresh",
      providerId: "generic",
      providerJobId: "generic_job",
      outputUrlPrivate: "https://downloads.example.com/expired.mp4?token=expired",
      outputUrlExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repository.insertJob(expired);

    await expect(refreshDownloadByInternalId(expired.id, contextFor(env))).rejects.toMatchObject({
      publicError: { code: "output_expired" },
    });
  });

  it("returns output_expired when the converted provider file was deleted", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("/download")) return new Response(null, { status: 404 });
      return new Response(null, { status: 204 });
    };
    const { env, repository } = await createEnv({
      ENABLED_PROVIDERS: "generic",
      PROVIDER_PRIORITY: "generic",
      GENERIC_PROVIDER_BASE_URL: "https://provider.example.com",
      GENERIC_PROVIDER_API_KEY: "provider-key",
      GENERIC_PROVIDER_REFRESH_PATH: "/jobs/{id}/download",
      TEST_FETCH: fetcher,
    });
    const expired = makeStoredJob({
      id: "job_deleted_output",
      providerId: "generic",
      providerJobId: "generic_deleted",
      outputUrlPrivate: "https://downloads.example.com/deleted.mp4",
      outputUrlExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repository.insertJob(expired);

    await expect(refreshDownloadByInternalId(expired.id, contextFor(env))).rejects.toMatchObject({
      publicError: { code: "output_expired" },
    });
  });

  it("rejects unauthorized download refresh requests", async () => {
    const { env, repository } = await createEnv();
    const expired = makeStoredJob({
      id: "job_unauthorized_refresh",
      publicId: "ec_job_unauthorized_refresh",
      apiKeyId: "key_test",
      providerId: "mock",
      providerJobId: "mock_unauthorized",
      outputUrlPrivate: "https://downloads.example.com/expired.mp4",
      outputUrlExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repository.insertJob(expired);
    const response = await app.fetch(
      request(`/api/v1/conversions/${expired.publicId}/refresh-download`, { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
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
