import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GenericHttpProvider,
  PublicApiError,
  validateExternalUrl,
  type ProviderDownloadResult,
} from "../packages/shared/src";
import { describe, expect, it } from "vitest";

const runRealProviderTest = process.env.RUN_REAL_PROVIDER_TEST === "1";
const execFileAsync = promisify(execFile);

describe.skipIf(!runRealProviderTest)("authorized real-provider M3U8 conversion", () => {
  it(
    "produces a playable non-empty MP4 without exposing credentials or signed URLs",
    async () => {
      const sourceUrl = requiredEnvironment("REAL_PROVIDER_M3U8_URL");
      const provider = new GenericHttpProvider({
        id: "real-provider",
        displayName: "Real Provider",
        baseUrl: requiredEnvironment("REAL_PROVIDER_BASE_URL"),
        apiKey: requiredEnvironment("REAL_PROVIDER_API_KEY"),
        authHeader: process.env.REAL_PROVIDER_AUTH_HEADER ?? "Authorization",
        authScheme: process.env.REAL_PROVIDER_AUTH_SCHEME ?? "Bearer",
        createPath: process.env.REAL_PROVIDER_CREATE_PATH ?? "/jobs",
        statusPath: process.env.REAL_PROVIDER_STATUS_PATH ?? "/jobs/{id}",
        cancelPath: process.env.REAL_PROVIDER_CANCEL_PATH,
        refreshPath: process.env.REAL_PROVIDER_REFRESH_PATH,
        webhookSecret: process.env.REAL_PROVIDER_WEBHOOK_SECRET,
        timeoutMs: 30_000,
        enabled: true,
        priority: 1,
        responseMappings: {
          providerJobId: "id",
          status: "status",
          outputUrl: "output.url",
          progress: "progress",
        },
      });
      const requestContext = {
        requestId: `real-provider-${crypto.randomUUID()}`,
        deadlineMs: Date.now() + 30_000,
        fetcher: fetch,
      };
      const created = await provider.createJob(
        {
          jobId: `real-${crypto.randomUUID()}`,
          idempotencyKey: `real-${crypto.randomUUID()}`,
          sourceUrl,
          format: "mp4",
          quality: "source",
        },
        requestContext,
      );

      let download: ProviderDownloadResult | undefined = created.download;
      const deadline = Date.now() + 10 * 60_000;
      while (!download && Date.now() < deadline) {
        const status = await provider.getJobStatus(created.providerJobId, requestContext);
        if (status.status === "failed" || status.status === "cancelled") {
          throw new PublicApiError(
            status.errorCode ?? "conversion_failed",
            502,
            "Real provider conversion did not complete",
          );
        }
        download = status.download;
        if (!download) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (!download) throw new Error("Real provider conversion timed out");

      const response = await downloadWithValidatedRedirects(download.url);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      expect(contentType).toContain("video/mp4");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);

      const directory = await mkdtemp(join(tmpdir(), "eliteconverter-real-"));
      const outputPath = join(directory, "output.mp4");
      try {
        await writeFile(outputPath, bytes);
        const { stdout } = await execFileAsync(
          process.env.REAL_PROVIDER_FFPROBE_PATH ?? "ffprobe",
          ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", outputPath],
          { windowsHide: true },
        );
        const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
        expect(probe.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
        if (process.env.REAL_PROVIDER_EXPECT_AUDIO === "1") {
          expect(probe.streams?.some((stream) => stream.codec_type === "audio")).toBe(true);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15 * 60_000,
  );
});

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be supplied when RUN_REAL_PROVIDER_TEST=1`);
  return value;
};

const downloadWithValidatedRedirects = async (rawUrl: string): Promise<Response> => {
  let current = validateExternalUrl(rawUrl, "output_unavailable").url;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new Error(`Provider output returned HTTP ${response.status}`);
      return response;
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("Provider output redirect omitted Location");
    current = validateExternalUrl(new URL(location, current).toString(), "output_unavailable").url;
  }
  throw new Error("Provider output exceeded the redirect limit");
};
