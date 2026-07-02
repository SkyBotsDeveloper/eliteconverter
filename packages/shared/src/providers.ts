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
  errorCode?: PublicErrorCode;
  retryable?: boolean;
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
  readonly id: string;
  readonly displayName: string;
  private static readonly jobs = new Map<
    string,
    { scenario: string; polls: number; jobId: string }
  >();
  private readonly capabilities: ProviderCapabilities;

  constructor(
    capabilities?: Partial<Pick<ProviderCapabilities, "formats" | "qualities">> & {
      id?: string;
      displayName?: string;
    },
  ) {
    this.id = capabilities?.id ?? "mock";
    this.displayName = capabilities?.displayName ?? "Mock Provider";
    this.capabilities = {
      formats: capabilities?.formats ?? [...outputFormats],
      qualities: capabilities?.qualities ?? [...qualityOptions],
      sourceExtensions: ["m3u8", "mp4", "webm", "mkv", "mp3", "m4a"],
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
    const scenario = input.scenario ?? scenarioFromUrl(input.sourceUrl, this.id);
    if (scenario === "timeout") {
      throw new PublicApiError("provider_timeout", 504, "Mock timeout scenario");
    }
    if (scenario === "rate-limit") {
      throw new PublicApiError("provider_rate_limited", 429, "Mock rate limit scenario");
    }
    if (scenario === "invalid-response") {
      throw new PublicApiError("provider_temporary_failure", 502, "Mock invalid response scenario");
    }

    const idempotencySuffix = (input.idempotencyKey ?? input.jobId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const providerJobId = `${this.id}_${idempotencySuffix}`;
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
    if (job.scenario === "async-fail") {
      return {
        providerJobId,
        status: "failed",
        progress: 100,
        stage: "temporary provider failure",
        errorCode: "provider_temporary_failure",
        retryable: true,
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
      errorCode:
        typeof body.errorCode === "string"
          ? (body.errorCode as PublicErrorCode)
          : body.status === "failed"
            ? "provider_permanent_failure"
            : undefined,
      retryable: body.retryable === true,
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
    const qualities = this.config.qualities.filter((quality) =>
      this.config.formats.some((format) => cloudConvertSupportsQuality(format, quality)),
    );
    return {
      formats: this.config.formats,
      qualities,
      sourceExtensions: [...cloudConvertSourceExtensions],
      qualityFormats: Object.fromEntries(
        qualities.map((quality) => [
          quality,
          this.config.formats.filter((format) => cloudConvertSupportsQuality(format, quality)),
        ]),
      ),
      supportsWebhooks: Boolean(this.config.webhookSigningSecret),
      supportsCancellation: false,
      supportsRefreshDownloadUrl: false,
      maxInputUrlLength: 4096,
    };
  }

  async createJob(
    input: ProviderCreateJobInput,
    context: ProviderRequestContext,
  ): Promise<ProviderCreateJobResult> {
    const source = cloudConvertSource(input.sourceUrl);
    const convertOptions = cloudConvertConversionOptions(input);
    const response = await this.request(context, "/jobs", {
      method: "POST",
      body: JSON.stringify({
        tag: input.jobId,
        tasks: {
          "import-source": {
            operation: "import/url",
            url: input.sourceUrl,
            filename: source.filename,
          },
          "convert-output": {
            operation: "convert",
            input: "import-source",
            input_format: source.inputFormat,
            output_format: input.format,
            ...convertOptions,
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
      ...cloudConvertFailure(job),
    };
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
      ...cloudConvertFailure(job),
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
  sourceExtensions?: string[];
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
      sourceExtensions: this.config.sourceExtensions,
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
    let response: Response;
    try {
      response = await this.request(
        context,
        this.config.refreshPath.replace("{id}", providerJobId),
        {
          method: "POST",
        },
      );
    } catch (error) {
      if (error instanceof PublicApiError && (error.status === 404 || error.status === 410)) {
        throw new PublicApiError("output_expired", 410, "Converted provider file was deleted");
      }
      throw error;
    }
    const body = await response.json();
    if (!isRecord(body) || typeof body.url !== "string") {
      throw new PublicApiError("output_unavailable", 502, "Invalid provider download response");
    }
    return {
      url: body.url,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
      fileSize: typeof body.fileSize === "number" ? body.fileSize : undefined,
    };
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
      errorCode:
        typeof parsed.errorCode === "string"
          ? (parsed.errorCode as PublicErrorCode)
          : parsed.status === "failed"
            ? "provider_permanent_failure"
            : undefined,
      retryable: parsed.retryable === true,
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

const scenarioFromUrl = (rawUrl: string, providerId = "mock"): string => {
  try {
    const parsed = new URL(rawUrl);
    const providerScenario = parsed.searchParams.get(providerId);
    if (providerScenario) return providerScenario;
    return parsed.searchParams.get("mock") ?? "success";
  } catch {
    return "success";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface CloudConvertTask {
  id?: string;
  name?: string;
  operation?: string;
  status?: string;
  createdAt?: string;
  endedAt?: string;
  code?: string;
  message?: string;
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
    ? body.data.tasks.filter(isRecord).map(readCloudConvertTaskRecord)
    : [];
  return {
    id: typeof body.data.id === "string" ? body.data.id : "",
    status: typeof body.data.status === "string" ? body.data.status : "waiting",
    tasks,
  };
};

const readCloudConvertTaskRecord = (task: Record<string, unknown>): CloudConvertTask => ({
  id: typeof task.id === "string" ? task.id : undefined,
  name: typeof task.name === "string" ? task.name : undefined,
  operation: typeof task.operation === "string" ? task.operation : undefined,
  status: typeof task.status === "string" ? task.status : undefined,
  createdAt: typeof task.created_at === "string" ? task.created_at : undefined,
  endedAt: typeof task.ended_at === "string" ? task.ended_at : undefined,
  code: typeof task.code === "string" ? task.code : undefined,
  message: typeof task.message === "string" ? task.message : undefined,
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
});

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

const cloudConvertSourceExtensions = [
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mp3",
  "m4a",
  "wav",
] as const;

const cloudConvertSource = (sourceUrl: string): { inputFormat: string; filename: string } => {
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    throw new PublicApiError("unsupported_source", 400, "CloudConvert source URL is invalid");
  }
  const filename = pathname.split("/").filter(Boolean).at(-1);
  const inputFormat = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!filename || !inputFormat) {
    throw new PublicApiError("unsupported_source", 400, "CloudConvert requires a source filename");
  }
  if (inputFormat === "m3u8") {
    throw new PublicApiError(
      "unsupported_source",
      400,
      "CloudConvert HLS playlist conversion has not been verified for this adapter",
    );
  }
  if (
    !cloudConvertSourceExtensions.includes(
      inputFormat as (typeof cloudConvertSourceExtensions)[number],
    )
  ) {
    throw new PublicApiError("unsupported_source", 400);
  }
  return { inputFormat, filename };
};

const cloudConvertConversionOptions = (
  input: ProviderCreateJobInput,
): Record<string, string | number> => {
  if (!cloudConvertSupportsQuality(input.format, input.quality)) {
    throw new PublicApiError("unsupported_quality", 400);
  }
  if (input.quality === "source") return {};
  if (input.quality === "1080p") return { width: 1920, height: 1080 };
  if (input.quality === "720p") return { width: 1280, height: 720 };
  if (input.quality === "480p") return { width: 854, height: 480 };
  if (input.quality === "audio") return {};
  throw new PublicApiError("unsupported_quality", 400);
};

const cloudConvertSupportsQuality = (format: OutputFormat, quality: QualityOption): boolean => {
  const audioFormat = format === "mp3" || format === "m4a";
  if (quality === "audio") return audioFormat;
  if (quality === "source") return true;
  return !audioFormat;
};

const cloudConvertDownload = (job: CloudConvertJob): ProviderDownloadResult | undefined => {
  const exportTask =
    job.tasks.find((task) => task.operation === "export/url") ??
    job.tasks.find((task) => task.name === "export-output");
  return exportTask ? cloudConvertTaskDownload(exportTask) : undefined;
};

const cloudConvertTaskDownload = (
  exportTask: CloudConvertTask,
): ProviderDownloadResult | undefined => {
  const file = exportTask?.result?.files?.find((candidate) => candidate.url);
  if (!file?.url) return undefined;
  return {
    url: file.url,
    expiresAt:
      (exportTask.endedAt ?? exportTask.createdAt)
        ? new Date(
            new Date(exportTask.endedAt ?? exportTask.createdAt ?? "").getTime() +
              24 * 60 * 60 * 1000,
          ).toISOString()
        : undefined,
    fileSize: file.size,
  };
};

const cloudConvertFailure = (
  job: CloudConvertJob,
): Pick<ProviderJobStatusResult, "errorCode" | "retryable"> => {
  if (normalizeCloudConvertStatus(job.status) !== "failed") return {};
  const failedTask = job.tasks.find((task) => task.status === "error");
  const diagnostic = `${failedTask?.code ?? ""} ${failedTask?.message ?? ""}`.toLowerCase();
  const retryable = /timeout|rate.?limit|temporary|internal|server|network|unavailable/.test(
    diagnostic,
  );
  return {
    errorCode: retryable ? "provider_temporary_failure" : "provider_permanent_failure",
    retryable,
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
