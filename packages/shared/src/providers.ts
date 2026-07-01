import { PublicApiError, classifyProviderHttpStatus } from "./catalog";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";
import type {
  OutputFormat,
  ProviderCapabilities,
  ProviderStatus,
  PublicErrorCode,
  QualityOption,
} from "./schemas";
import { outputFormats, qualityOptions } from "./schemas";
import { validateExternalUrl } from "./url-security";
import { verifyWebhookSignature } from "./webhooks";

export interface ProviderCreateJobInput {
  jobId: string;
  idempotencyKey?: string;
  sourceUrl: string;
  format: OutputFormat;
  quality: QualityOption;
  callbackUrl?: string;
  scenario?: string;
}

export interface ProviderRequestContext {
  requestId: string;
  deadlineMs: number;
  fetcher: typeof fetch;
}

export interface ProviderDownloadResult {
  url: string;
  expiresAt?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface ProviderCreateJobResult {
  providerJobId: string;
  status: ProviderStatus;
  download?: ProviderDownloadResult;
}

export interface ProviderJobStatusResult {
  providerJobId: string;
  status: ProviderStatus;
  progress: number;
  stage: string;
  download?: ProviderDownloadResult;
  errorCode?: PublicErrorCode;
  retryable?: boolean;
}

export interface VerifiedProviderWebhookEvent {
  providerId: string;
  providerEventId: string;
  providerJobId: string;
  status: ProviderStatus;
  progress?: number;
  download?: ProviderDownloadResult;
}

export interface ConversionProvider {
  readonly id: string;
  readonly displayName: string;

  getCapabilities(): Promise<ProviderCapabilities>;

  createJob(
    input: ProviderCreateJobInput,
    context: ProviderRequestContext,
  ): Promise<ProviderCreateJobResult>;

  getJobStatus(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderJobStatusResult>;

  cancelJob?(providerJobId: string, context: ProviderRequestContext): Promise<void>;

  refreshDownloadUrl?(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderDownloadResult>;

  verifyWebhook?(request: Request): Promise<VerifiedProviderWebhookEvent>;
}

export class MockProvider implements ConversionProvider {
  readonly id = "mock";
  readonly displayName = "Mock Provider";
  private static readonly jobs = new Map<
    string,
    { scenario: string; polls: number; jobId: string }
  >();
  private readonly capabilities: ProviderCapabilities;

  constructor(capabilities?: Partial<Pick<ProviderCapabilities, "formats" | "qualities">>) {
    this.capabilities = {
      formats: capabilities?.formats ?? [...outputFormats],
      qualities: capabilities?.qualities ?? [...qualityOptions],
      supportsWebhooks: true,
      supportsCancellation: true,
      supportsRefreshDownloadUrl: true,
      maxInputUrlLength: 4096,
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return this.capabilities;
  }

  async createJob(
    input: ProviderCreateJobInput,
    _context?: ProviderRequestContext,
  ): Promise<ProviderCreateJobResult> {
    const scenario = input.scenario ?? scenarioFromUrl(input.sourceUrl);
    if (scenario === "timeout") {
      throw new PublicApiError("provider_timeout", 504, "Mock timeout scenario");
    }
    if (scenario === "rate-limit") {
      throw new PublicApiError("provider_rate_limited", 429, "Mock rate limit scenario");
    }
    if (scenario === "invalid-response") {
      throw new PublicApiError("provider_temporary_failure", 502, "Mock invalid response scenario");
    }

    const providerJobId = `mock_${input.jobId}`;
    MockProvider.jobs.set(providerJobId, { scenario, polls: 0, jobId: input.jobId });
    return { providerJobId, status: scenario === "retry" ? "retrying" : "queued" };
  }

  async getJobStatus(
    providerJobId: string,
    _context?: ProviderRequestContext,
  ): Promise<ProviderJobStatusResult> {
    const job = MockProvider.jobs.get(providerJobId);
    if (!job) {
      throw new PublicApiError("provider_permanent_failure", 404, "Unknown mock provider job");
    }
    job.polls += 1;

    if (job.scenario === "fail") {
      return {
        providerJobId,
        status: "failed",
        progress: 100,
        stage: "failed",
        errorCode: "conversion_failed",
        retryable: false,
      };
    }
    if (job.scenario === "permanent") {
      return {
        providerJobId,
        status: "failed",
        progress: 100,
        stage: "rejected",
        errorCode: "provider_permanent_failure",
        retryable: false,
      };
    }
    if (job.scenario.startsWith("long-")) {
      const requiredPolls = Number(job.scenario.replace("long-", ""));
      if (Number.isFinite(requiredPolls) && job.polls <= requiredPolls) {
        return {
          providerJobId,
          status: "processing",
          progress: Math.min(95, Math.floor((job.polls / requiredPolls) * 90)),
          stage: `processing poll ${job.polls}`,
        };
      }
    }
    if (job.scenario === "retry" && job.polls < 2) {
      return {
        providerJobId,
        status: "retrying",
        progress: 45,
        stage: "retrying provider operation",
        errorCode: "provider_temporary_failure",
        retryable: true,
      };
    }

    return {
      providerJobId,
      status: "completed",
      progress: 100,
      stage: "completed",
      download: this.makeDownload(providerJobId),
    };
  }

  async cancelJob(providerJobId: string, _context?: ProviderRequestContext): Promise<void> {
    MockProvider.jobs.delete(providerJobId);
  }

  async refreshDownloadUrl(
    providerJobId: string,
    _context?: ProviderRequestContext,
  ): Promise<ProviderDownloadResult> {
    return this.makeDownload(providerJobId, 2);
  }

  async verifyWebhook(request: Request): Promise<VerifiedProviderWebhookEvent> {
    const body = await request.json();
    if (!isRecord(body)) throw new PublicApiError("validation_error", 400);
    return {
      providerId: this.id,
      providerEventId: String(body.eventId ?? `mock_evt_${Date.now()}`),
      providerJobId: String(body.providerJobId ?? ""),
      status: String(body.status ?? "completed") as ProviderStatus,
      progress: typeof body.progress === "number" ? body.progress : 100,
      download:
        typeof body.outputUrl === "string"
          ? { url: body.outputUrl, mimeType: "video/mp4" }
          : undefined,
    };
  }

  private makeDownload(providerJobId: string, hours = 1): ProviderDownloadResult {
    return {
      url: `https://downloads.example.com/eliteconverter/${encodeURIComponent(providerJobId)}.mp4?token=mock-token&signature=mock-signature&policy=mock-policy&expires=4102444800`,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
      mimeType: "video/mp4",
      fileSize: 1048576,
    };
  }
}

export interface CloudConvertProviderConfig {
  baseUrl: string;
  apiKey: string;
  webhookSigningSecret?: string;
  timeoutMs: number;
  formats: OutputFormat[];
  qualities: QualityOption[];
}

export class CloudConvertProvider implements ConversionProvider {
  readonly id = "cloudconvert";
  readonly displayName = "CloudConvert";
  private readonly config: CloudConvertProviderConfig;

  constructor(config: CloudConvertProviderConfig) {
    if (!config.baseUrl.trim() || !config.apiKey.trim()) {
      throw new PublicApiError(
        "internal_configuration_error",
        500,
        "CloudConvert provider is enabled but required configuration is missing",
      );
    }
    validateExternalUrl(config.baseUrl, "internal_configuration_error");
    this.config = config;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      formats: this.config.formats,
      qualities: this.config.qualities,
      supportsWebhooks: Boolean(this.config.webhookSigningSecret),
      supportsCancellation: false,
      supportsRefreshDownloadUrl: true,
      maxInputUrlLength: 4096,
    };
  }

  async createJob(
    input: ProviderCreateJobInput,
    context: ProviderRequestContext,
  ): Promise<ProviderCreateJobResult> {
    const response = await this.request(context, "/jobs", {
      method: "POST",
      body: JSON.stringify({
        tag: input.jobId,
        tasks: {
          "import-source": {
            operation: "import/url",
            url: input.sourceUrl,
          },
          "convert-output": {
            operation: "convert",
            input: "import-source",
            output_format: input.format,
          },
          "export-output": {
            operation: "export/url",
            input: "convert-output",
          },
        },
      }),
    });
    const job = readCloudConvertJob(await response.json());
    if (!job.id) throw new PublicApiError("provider_temporary_failure", 502);
    return {
      providerJobId: job.id,
      status: normalizeCloudConvertStatus(job.status),
      download: cloudConvertDownload(job),
    };
  }

  async getJobStatus(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderJobStatusResult> {
    const response = await this.request(context, `/jobs/${encodeURIComponent(providerJobId)}`);
    const job = readCloudConvertJob(await response.json());
    const status = normalizeCloudConvertStatus(job.status);
    return {
      providerJobId,
      status,
      progress: status === "completed" || status === "failed" ? 100 : cloudConvertProgress(job),
      stage: cloudConvertStage(job),
      download: cloudConvertDownload(job),
      errorCode: status === "failed" ? "conversion_failed" : undefined,
      retryable: false,
    };
  }

  async refreshDownloadUrl(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderDownloadResult> {
    const status = await this.getJobStatus(providerJobId, context);
    if (!status.download) throw new PublicApiError("output_expired", 400);
    return status.download;
  }

  async verifyWebhook(request: Request): Promise<VerifiedProviderWebhookEvent> {
    if (!this.config.webhookSigningSecret) {
      throw new PublicApiError("internal_configuration_error", 500, "Missing webhook secret");
    }
    const body = await request.text();
    const signature = request.headers.get("CloudConvert-Signature");
    const expected = await hmacSha256Hex(this.config.webhookSigningSecret, body);
    if (!signature || !timingSafeEqual(signature, expected)) {
      throw new PublicApiError("forbidden", 403, "Invalid provider webhook signature");
    }
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.job)) {
      throw new PublicApiError("validation_error", 400);
    }
    const job = readCloudConvertJob({ data: parsed.job });
    const event = typeof parsed.event === "string" ? parsed.event : job.status;
    const status = event === "job.failed" ? "failed" : normalizeCloudConvertStatus(job.status);
    return {
      providerId: this.id,
      providerEventId: `${event}:${job.id}`,
      providerJobId: job.id,
      status,
      progress: status === "completed" || status === "failed" ? 100 : cloudConvertProgress(job),
      download: cloudConvertDownload(job),
    };
  }

  private async request(
    context: ProviderRequestContext,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const url = new URL(path, this.config.baseUrl).toString();
    validateExternalUrl(url, "internal_configuration_error");
    try {
      const response = await context.fetcher(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        throw new PublicApiError(classifyProviderHttpStatus(response.status), response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw new PublicApiError("provider_timeout", 504, "Provider request failed or timed out");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface GenericHttpProviderConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  authHeader: string;
  authScheme: string;
  createPath: string;
  statusPath: string;
  cancelPath?: string;
  refreshPath?: string;
  webhookSecret?: string;
  timeoutMs: number;
  enabled: boolean;
  priority: number;
  responseMappings: {
    providerJobId: string;
    status: string;
    outputUrl?: string;
    progress?: string;
  };
}

export const validateGenericProviderConfig = (
  config: GenericHttpProviderConfig,
): GenericHttpProviderConfig => {
  if (!config.enabled) return config;
  const required = [
    config.baseUrl,
    config.apiKey,
    config.authHeader,
    config.authScheme,
    config.createPath,
    config.statusPath,
  ];
  if (required.some((value) => !value.trim())) {
    throw new PublicApiError(
      "internal_configuration_error",
      500,
      "Generic provider is enabled but required configuration is missing",
    );
  }
  validateExternalUrl(config.baseUrl, "internal_configuration_error");
  return config;
};

export class GenericHttpProvider implements ConversionProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly config: GenericHttpProviderConfig;

  constructor(config: GenericHttpProviderConfig) {
    this.config = validateGenericProviderConfig(config);
    this.id = config.id;
    this.displayName = config.displayName;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      formats: ["mp4", "webm", "mkv", "mp3", "m4a"],
      qualities: ["source", "1080p", "720p", "480p", "audio"],
      supportsWebhooks: Boolean(this.config.webhookSecret),
      supportsCancellation: Boolean(this.config.cancelPath),
      supportsRefreshDownloadUrl: Boolean(this.config.refreshPath),
      maxInputUrlLength: 4096,
    };
  }

  async createJob(
    input: ProviderCreateJobInput,
    context: ProviderRequestContext,
  ): Promise<ProviderCreateJobResult> {
    const response = await this.request(context, this.config.createPath, {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: input.sourceUrl,
        format: input.format,
        quality: input.quality,
        callbackUrl: input.callbackUrl,
        idempotencyKey: input.idempotencyKey,
      }),
    });
    const body = await response.json();
    if (!isRecord(body)) throw new PublicApiError("provider_temporary_failure", 502);
    const providerJobId = readMappedString(body, this.config.responseMappings.providerJobId);
    const status = normalizeProviderStatus(
      readMappedString(body, this.config.responseMappings.status, "queued"),
    );
    if (!providerJobId) throw new PublicApiError("provider_temporary_failure", 502);
    return { providerJobId, status };
  }

  async getJobStatus(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderJobStatusResult> {
    const response = await this.request(
      context,
      this.config.statusPath.replace("{id}", providerJobId),
    );
    const body = await response.json();
    if (!isRecord(body)) throw new PublicApiError("provider_temporary_failure", 502);
    const status = normalizeProviderStatus(
      readMappedString(body, this.config.responseMappings.status, "processing"),
    );
    const outputUrl = this.config.responseMappings.outputUrl
      ? readMappedString(body, this.config.responseMappings.outputUrl)
      : undefined;
    const progress = this.config.responseMappings.progress
      ? Number(readMappedString(body, this.config.responseMappings.progress, "0"))
      : status === "completed"
        ? 100
        : 50;
    return {
      providerJobId,
      status,
      progress,
      stage: status,
      download: outputUrl ? { url: outputUrl } : undefined,
    };
  }

  async cancelJob(providerJobId: string, context: ProviderRequestContext): Promise<void> {
    if (!this.config.cancelPath) return;
    await this.request(context, this.config.cancelPath.replace("{id}", providerJobId), {
      method: "POST",
    });
  }

  async refreshDownloadUrl(
    providerJobId: string,
    context: ProviderRequestContext,
  ): Promise<ProviderDownloadResult> {
    if (!this.config.refreshPath) {
      throw new PublicApiError("output_expired", 400, "Provider cannot refresh downloads");
    }
    const response = await this.request(
      context,
      this.config.refreshPath.replace("{id}", providerJobId),
      {
        method: "POST",
      },
    );
    const body = await response.json();
    if (!isRecord(body) || typeof body.url !== "string") {
      throw new PublicApiError("output_unavailable", 502, "Invalid provider download response");
    }
    return { url: body.url };
  }

  async verifyWebhook(request: Request): Promise<VerifiedProviderWebhookEvent> {
    if (!this.config.webhookSecret) {
      throw new PublicApiError("internal_configuration_error", 500, "Missing webhook secret");
    }
    const body = await request.text();
    const valid = await verifyWebhookSignature(this.config.webhookSecret, body, request.headers);
    if (!valid) throw new PublicApiError("forbidden", 403, "Invalid provider webhook signature");
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) throw new PublicApiError("validation_error", 400);
    return {
      providerId: this.id,
      providerEventId: String(parsed.eventId ?? parsed.id ?? ""),
      providerJobId: String(parsed.providerJobId ?? parsed.jobId ?? ""),
      status: normalizeProviderStatus(String(parsed.status ?? "processing")),
      progress: typeof parsed.progress === "number" ? parsed.progress : undefined,
      download: typeof parsed.outputUrl === "string" ? { url: parsed.outputUrl } : undefined,
    };
  }

  private async request(
    context: ProviderRequestContext,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const url = new URL(path, this.config.baseUrl).toString();
    validateExternalUrl(url, "internal_configuration_error");

    try {
      const response = await context.fetcher(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          [this.config.authHeader]: `${this.config.authScheme} ${this.config.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        throw new PublicApiError(classifyProviderHttpStatus(response.status), response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw new PublicApiError("provider_timeout", 504, "Provider request failed or timed out");
    } finally {
      clearTimeout(timeout);
    }
  }
}

const scenarioFromUrl = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get("mock") ?? "success";
  } catch {
    return "success";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface CloudConvertTask {
  name?: string;
  operation?: string;
  status?: string;
  result?: {
    files?: Array<{
      url?: string;
      filename?: string;
      size?: number;
    }>;
  };
}

interface CloudConvertJob {
  id: string;
  status: string;
  tasks: CloudConvertTask[];
}

const readCloudConvertJob = (body: unknown): CloudConvertJob => {
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new PublicApiError("provider_temporary_failure", 502);
  }
  const tasks = Array.isArray(body.data.tasks)
    ? body.data.tasks.filter(isRecord).map((task) => ({
        name: typeof task.name === "string" ? task.name : undefined,
        operation: typeof task.operation === "string" ? task.operation : undefined,
        status: typeof task.status === "string" ? task.status : undefined,
        result: isRecord(task.result)
          ? {
              files: Array.isArray(task.result.files)
                ? task.result.files.filter(isRecord).map((file) => ({
                    url: typeof file.url === "string" ? file.url : undefined,
                    filename: typeof file.filename === "string" ? file.filename : undefined,
                    size: typeof file.size === "number" ? file.size : undefined,
                  }))
                : undefined,
            }
          : undefined,
      }))
    : [];
  return {
    id: typeof body.data.id === "string" ? body.data.id : "",
    status: typeof body.data.status === "string" ? body.data.status : "waiting",
    tasks,
  };
};

const normalizeCloudConvertStatus = (status: string): ProviderStatus => {
  switch (status) {
    case "finished":
      return "completed";
    case "error":
      return "failed";
    case "waiting":
      return "queued";
    default:
      return "processing";
  }
};

const cloudConvertDownload = (job: CloudConvertJob): ProviderDownloadResult | undefined => {
  const exportTask =
    job.tasks.find((task) => task.operation === "export/url") ??
    job.tasks.find((task) => task.name === "export-output");
  const file = exportTask?.result?.files?.find((candidate) => candidate.url);
  if (!file?.url) return undefined;
  return {
    url: file.url,
    fileSize: file.size,
  };
};

const cloudConvertStage = (job: CloudConvertJob): string => {
  const active =
    job.tasks.find((task) => task.status === "processing") ??
    job.tasks.find((task) => task.status === "waiting");
  return active?.operation ?? job.status;
};

const cloudConvertProgress = (job: CloudConvertJob): number => {
  if (!job.tasks.length) return 10;
  const finished = job.tasks.filter((task) => task.status === "finished").length;
  return Math.max(10, Math.min(95, Math.round((finished / job.tasks.length) * 90)));
};

const readMappedString = (object: Record<string, unknown>, path: string, fallback = ""): string => {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (isRecord(current)) return current[key];
    return undefined;
  }, object);
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
};

const normalizeProviderStatus = (value: string): ProviderStatus => {
  switch (value) {
    case "queued":
    case "processing":
    case "retrying":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "processing";
  }
};
