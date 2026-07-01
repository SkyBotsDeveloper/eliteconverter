import { z } from "zod";

export const outputFormats = ["mp4", "webm", "mkv", "mp3", "m4a"] as const;
export const qualityOptions = ["source", "1080p", "720p", "480p", "audio"] as const;
export const jobStatuses = [
  "pending",
  "validating",
  "queued",
  "submitting",
  "submitted",
  "processing",
  "retrying",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "expired",
] as const;

export const publicErrorCodes = [
  "invalid_source_url",
  "unsupported_source",
  "unsupported_format",
  "unsupported_quality",
  "source_unreachable",
  "source_expired",
  "source_authentication_required",
  "drm_protected_source",
  "provider_timeout",
  "provider_rate_limited",
  "provider_temporary_failure",
  "provider_permanent_failure",
  "conversion_failed",
  "output_unavailable",
  "output_expired",
  "internal_configuration_error",
  "internal_error",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "idempotency_conflict",
  "validation_error",
  "not_found",
] as const;

export type OutputFormat = (typeof outputFormats)[number];
export type QualityOption = (typeof qualityOptions)[number];
export type JobStatus = (typeof jobStatuses)[number];
export type PublicErrorCode = (typeof publicErrorCodes)[number];

export const callbackUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const conversionRequestSchema = z.object({
  url: z.string().trim().min(8).max(4096),
  format: z.enum(outputFormats),
  quality: z.enum(qualityOptions),
  callbackUrl: callbackUrlSchema,
});

export const publicConversionRequestSchema = conversionRequestSchema.extend({
  turnstileToken: z.string().trim().min(4).max(4096),
  permissionConfirmed: z.literal(true),
});

export const providerStatusSchema = z.enum([
  "queued",
  "processing",
  "retrying",
  "completed",
  "failed",
  "cancelled",
]);

export const providerDownloadSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime().optional(),
  mimeType: z.string().max(128).optional(),
  fileSize: z.number().int().positive().optional(),
});

export type ConversionRequest = z.infer<typeof conversionRequestSchema>;
export type PublicConversionRequest = z.infer<typeof publicConversionRequestSchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export interface PublicError {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  error: PublicError;
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ProviderCapabilities {
  formats: OutputFormat[];
  qualities: QualityOption[];
  supportsWebhooks: boolean;
  supportsCancellation: boolean;
  supportsRefreshDownloadUrl: boolean;
  maxInputUrlLength: number;
}

export interface PublicJob {
  jobId: string;
  status: JobStatus;
  progress: number;
  currentStage: string;
  format: OutputFormat;
  quality: QualityOption;
  inputUrlRedacted: string;
  sourceHostname: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  outputUrl?: string;
  outputUrlExpiresAt?: string;
  outputMimeType?: string;
  outputFileSize?: number;
  error?: PublicError;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  message: string;
  safeDetails?: string;
  createdAt: string;
}

export interface CapabilitiesResponse {
  product: "EliteConverter";
  tagline: "Convert Streams. Deliver Anywhere.";
  formats: OutputFormat[];
  qualities: QualityOption[];
  providers: Array<{
    id: string;
    displayName: string;
    capabilities: ProviderCapabilities;
  }>;
  responsibleUseNotice: string;
}

export interface StatusResponse {
  api: "operational" | "degraded" | "outage";
  database: "operational" | "degraded" | "outage";
  queue: "operational" | "degraded" | "outage";
  conversionSystem: "operational" | "degraded" | "outage";
  providerNetwork: "operational" | "degraded" | "outage";
  incidents: Array<{
    id: string;
    title: string;
    status: string;
    severity: string;
    message: string;
    updatedAt: string;
  }>;
}

export const responsibleUseNotice =
  "Only convert media that you own or have permission to process. EliteConverter does not support DRM-protected content or bypass access restrictions.";
