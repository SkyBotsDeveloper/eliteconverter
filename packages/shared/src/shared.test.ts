import { describe, expect, it } from "vitest";
import {
  CloudConvertProvider,
  MockProvider,
  calculateBackoffMs,
  createApiKey,
  hashApiKey,
  isBlockedHostname,
  isPrivateIpv4,
  isRetryableError,
  publicErrorCatalog,
  signWebhookPayload,
  timingSafeEqual,
  validateExternalUrl,
  validateRedirectChain,
  verifyWebhookSignature,
} from ".";

describe("URL security", () => {
  it("rejects private IPv4, localhost, metadata and private IPv6 hosts", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.1.10")).toBe(true);
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isBlockedHostname("[::1]")).toBe(true);
  });

  it("rejects encoded and numeric IP tricks", () => {
    expect(isBlockedHostname("2130706433")).toBe(true);
    expect(isBlockedHostname("0x7f000001")).toBe(true);
    expect(() => validateExternalUrl("http://127.0.0.1/master.m3u8")).toThrow();
  });

  it("allows normal http and https public URLs and redacts tokens", () => {
    const result = validateExternalUrl("https://media.example.com/master.m3u8?token=secret");
    expect(result.hostname).toBe("media.example.com");
    expect(result.redactedUrl).toContain("token=%3Credacted%3E");
  });

  it("rejects unsupported protocols and DRM hints", () => {
    expect(() => validateExternalUrl("file:///etc/passwd")).toThrow();
    expect(() => validateExternalUrl("https://example.com/widevine/license.m3u8")).toThrow();
  });

  it("rejects unsafe output redirect chains", async () => {
    await expect(
      validateRedirectChain("https://downloads.example.com/file.mp4", {
        fetcher: async () =>
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1/file.mp4" } }),
      }),
    ).rejects.toThrow();
  });
});

describe("crypto and webhooks", () => {
  it("hashes API keys and compares signatures safely", async () => {
    const apiKey = createApiKey("test");
    const first = await hashApiKey(apiKey, "secret");
    const second = await hashApiKey(apiKey, "secret");
    expect(first).toBe(second);
    expect(timingSafeEqual(first, second)).toBe(true);
    expect(timingSafeEqual(first, `${second}x`)).toBe(false);
  });

  it("signs and validates webhook timestamps", async () => {
    const signed = await signWebhookPayload(
      "secret",
      JSON.stringify({ ok: true }),
      "100",
      "evt_test",
    );
    const headers = new Headers({
      "EliteConverter-Event-Id": signed.eventId,
      "EliteConverter-Timestamp": signed.timestamp,
      "EliteConverter-Signature": signed.signature,
    });
    await expect(verifyWebhookSignature("secret", signed.body, headers, 300, 120)).resolves.toBe(
      true,
    );
    await expect(verifyWebhookSignature("secret", signed.body, headers, 10, 500)).resolves.toBe(
      false,
    );
  });
});

describe("retry and provider behavior", () => {
  it("calculates bounded exponential backoff with jitter", () => {
    expect(
      calculateBackoffMs(
        1,
        { initialDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3, jitterRatio: 0.1 },
        () => 0,
      ),
    ).toBe(100);
    expect(
      calculateBackoffMs(
        4,
        { initialDelayMs: 100, maxDelayMs: 500, maxAttempts: 3, jitterRatio: 0.5 },
        () => 1,
      ),
    ).toBe(500);
    expect(isRetryableError("provider_rate_limited")).toBe(true);
    expect(isRetryableError("unsupported_format")).toBe(false);
  });

  it("runs deterministic mock provider scenarios", async () => {
    const provider = new MockProvider();
    const created = await provider.createJob(
      {
        jobId: "job_1",
        sourceUrl: "https://media.example.com/master.m3u8?mock=retry",
        format: "mp4",
        quality: "source",
      },
      { requestId: "req", deadlineMs: Date.now() + 1000, fetcher: fetch },
    );
    const first = await provider.getJobStatus(created.providerJobId, {
      requestId: "req",
      deadlineMs: Date.now() + 1000,
      fetcher: fetch,
    });
    const second = await provider.getJobStatus(created.providerJobId, {
      requestId: "req",
      deadlineMs: Date.now() + 1000,
      fetcher: fetch,
    });
    expect(first.status).toBe("retrying");
    expect(second.status).toBe("completed");
    expect(second.download?.url).toContain("downloads.example.com");
  });

  it("maps CloudConvert job/task responses through the provider contract", async () => {
    const requestBodies: unknown[] = [];
    const provider = new CloudConvertProvider({
      baseUrl: "https://api.cloudconvert.com/v2",
      apiKey: "test-key",
      timeoutMs: 1000,
      formats: ["mp4"],
      qualities: ["source"],
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.body) requestBodies.push(JSON.parse(String(init.body)) as unknown);
      if (url.endsWith("/jobs")) {
        return Response.json({ data: { id: "cc_job_1", status: "waiting", tasks: [] } });
      }
      return Response.json({
        data: {
          id: "cc_job_1",
          status: "finished",
          tasks: [
            {
              name: "export-output",
              operation: "export/url",
              status: "finished",
              result: {
                files: [{ url: "https://downloads.example.com/out.mp4?token=cc-token" }],
              },
            },
          ],
        },
      });
    };

    const created = await provider.createJob(
      {
        jobId: "job_1",
        sourceUrl: "https://media.example.com/master.m3u8",
        format: "mp4",
        quality: "source",
      },
      { requestId: "req", deadlineMs: Date.now() + 1000, fetcher },
    );
    const status = await provider.getJobStatus("cc_job_1", {
      requestId: "req",
      deadlineMs: Date.now() + 1000,
      fetcher,
    });

    expect(created.providerJobId).toBe("cc_job_1");
    expect(requestBodies[0]).toMatchObject({
      tasks: {
        "import-source": { operation: "import/url" },
        "convert-output": { operation: "convert", output_format: "mp4" },
        "export-output": { operation: "export/url" },
      },
    });
    expect(status.status).toBe("completed");
    expect(status.download?.url).toContain("token=cc-token");
  });

  it("publishes a complete public error catalog", () => {
    expect(publicErrorCatalog.invalid_source_url.retryable).toBe(false);
    expect(publicErrorCatalog.provider_timeout.retryable).toBe(true);
    expect(publicErrorCatalog.drm_protected_source.message).toContain("DRM");
  });
});
