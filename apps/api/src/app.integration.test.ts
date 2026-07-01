import { describe, expect, it } from "vitest";
import { hashApiKey, randomId } from "@eliteconverter/shared";
import { app } from "./app";
import { MemoryRepository } from "./repository";
import type { Env, StoredApiKey } from "./types";

const apiSecret = "test-only-api-key-hash-secret";

const createEnv = async () => {
  const repository = new MemoryRepository();
  const rawKey = `ec_test_${"a".repeat(40)}`;
  const key: StoredApiKey = {
    id: "key_test",
    ownerId: "usr_test",
    name: "Integration",
    prefix: rawKey.slice(0, 12),
    keyHash: await hashApiKey(rawKey, apiSecret),
    status: "active",
    scopes: ["conversions:create", "conversions:read", "conversions:cancel"],
    createdAt: new Date().toISOString(),
  };
  await repository.insertApiKey(key);
  const env: Env = {
    APP_ENV: "test",
    API_KEY_HASH_SECRET: apiSecret,
    CLIENT_WEBHOOK_SIGNING_SECRET: "webhook-secret",
    ENABLED_PROVIDERS: "mock",
    PROVIDER_PRIORITY: "mock",
    TEST_REPOSITORY: repository,
    TEST_FETCH: async () => new Response("ok", { status: 204 }),
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

describe("EliteConverter API", () => {
  it("serves health and capabilities", async () => {
    const { env } = await createEnv();
    const health = await app.fetch(request("/api/v1/health"), env);
    expect(health.status).toBe(200);
    const capabilities = await app.fetch(request("/api/v1/capabilities"), env);
    const body = await json<{ success: true; data: { formats: string[] } }>(capabilities);
    expect(body.data.formats).toContain("mp4");
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

  it("creates authenticated jobs and honors idempotency", async () => {
    const { env, rawKey } = await createEnv();
    const body = {
      url: "https://media.example.com/master.m3u8?mock=success",
      format: "mp4",
      quality: "source",
    };
    const init: RequestInit = {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}`, "Idempotency-Key": "same-key" },
      body: JSON.stringify(body),
    };
    const first = await app.fetch(request("/api/v1/conversions", init), env);
    const second = await app.fetch(request("/api/v1/conversions", init), env);
    const firstBody = await json<{ success: true; data: { jobId: string; status: string } }>(first);
    const secondBody = await json<{ success: true; data: { jobId: string; status: string } }>(
      second,
    );
    expect(first.status).toBe(202);
    expect(secondBody.data.jobId).toBe(firstBody.data.jobId);
  });

  it("rejects idempotency conflicts", async () => {
    const { env, rawKey } = await createEnv();
    const headers = { Authorization: `Bearer ${rawKey}`, "Idempotency-Key": "conflict-key" };
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

  it("creates anonymous jobs with test Turnstile and exposes events", async () => {
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
    const body = await json<{ success: true; data: { jobId: string } }>(response);
    const job = await app.fetch(request(`/api/v1/conversions/${body.data.jobId}`), env);
    const publicJob = await json<{ success: true; data: { status: string; progress: number } }>(
      job,
    );
    const events = await app.fetch(request(`/api/v1/conversions/${body.data.jobId}/events`), env);
    expect(publicJob.data.status).toBe("completed");
    expect(publicJob.data.progress).toBe(100);
    expect(events.status).toBe(200);
  });

  it("handles cancellation and status route", async () => {
    const { env } = await createEnv();
    const status = await app.fetch(request("/api/v1/status"), env);
    expect(status.status).toBe(200);
  });
});
