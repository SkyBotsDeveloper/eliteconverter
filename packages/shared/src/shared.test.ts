import { describe, expect, it } from "vitest";
import {
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

  it("publishes a complete public error catalog", () => {
    expect(publicErrorCatalog.invalid_source_url.retryable).toBe(false);
    expect(publicErrorCatalog.provider_timeout.retryable).toBe(true);
    expect(publicErrorCatalog.drm_protected_source.message).toContain("DRM");
  });
});
