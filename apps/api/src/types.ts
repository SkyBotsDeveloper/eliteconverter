import type {
  JobEvent,
  JobStatus,
  OutputFormat,
  PublicErrorCode,
  QualityOption,
} from "@eliteconverter/shared";
import type { MemoryRepository, Repository } from "./repository";

export interface RateLimiterBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface QueuePayload {
  jobId: string;
  requestId: string;
}

export interface Env {
  DB?: D1Database;
  CONVERSION_QUEUE?: Queue<QueuePayload>;
  RATE_LIMITER?: RateLimiterBinding;
  ASSETS?: Fetcher;
  APP_ENV?: string;
  APP_BASE_URL?: string;
  API_BASE_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  API_KEY_HASH_SECRET?: string;
  CLIENT_WEBHOOK_SIGNING_SECRET?: string;
  ENABLED_PROVIDERS?: string;
  PROVIDER_PRIORITY?: string;
  GENERIC_PROVIDER_BASE_URL?: string;
  GENERIC_PROVIDER_API_KEY?: string;
  GENERIC_PROVIDER_AUTH_HEADER?: string;
  GENERIC_PROVIDER_AUTH_SCHEME?: string;
  GENERIC_PROVIDER_CREATE_PATH?: string;
  GENERIC_PROVIDER_STATUS_PATH?: string;
  GENERIC_PROVIDER_CANCEL_PATH?: string;
  GENERIC_PROVIDER_REFRESH_PATH?: string;
  GENERIC_PROVIDER_WEBHOOK_SECRET?: string;
  GENERIC_PROVIDER_TIMEOUT_MS?: string;
  MAX_PROVIDER_ATTEMPTS?: string;
  MAX_RETRY_ATTEMPTS?: string;
  INITIAL_RETRY_DELAY_MS?: string;
  MAX_RETRY_DELAY_MS?: string;
  JOB_EXPIRATION_HOURS?: string;
  STUCK_JOB_THRESHOLD_MINUTES?: string;
  CIRCUIT_BREAKER_THRESHOLD?: string;
  CIRCUIT_BREAKER_COOLDOWN_SECONDS?: string;
  MAX_CONCURRENT_JOBS_PER_USER?: string;
  MAX_ANONYMOUS_JOBS_PER_DAY?: string;
  TEST_REPOSITORY?: MemoryRepository;
  TEST_FETCH?: typeof fetch;
}

export interface AppConfig {
  appEnv: "development" | "test" | "staging" | "production";
  appBaseUrl: string;
  apiBaseUrl: string;
  corsAllowedOrigins: string[];
  turnstileSecretKey?: string;
  apiKeyHashSecret: string;
  clientWebhookSigningSecret: string;
  enabledProviders: string[];
  providerPriority: string[];
  genericProvider: {
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
  };
  maxProviderAttempts: number;
  maxRetryAttempts: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  jobExpirationHours: number;
  staleJobThresholdMinutes: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownSeconds: number;
  maxConcurrentJobsPerUser: number;
  maxAnonymousJobsPerDay: number;
}

export interface RequestContext {
  requestId: string;
  env: Env;
  config: AppConfig;
  repository: Repository;
  fetcher: typeof fetch;
}

export interface StoredApiKey {
  id: string;
  ownerId: string;
  name: string;
  prefix: string;
  keyHash: string;
  status: "active" | "revoked";
  scopes: string[];
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface StoredJob {
  id: string;
  publicId: string;
  ownerId?: string;
  anonymousSessionId?: string;
  apiKeyId?: string;
  inputUrl: string;
  inputUrlRedacted: string;
  sourceHostname: string;
  format: OutputFormat;
  quality: QualityOption;
  status: JobStatus;
  progress: number;
  currentStage: string;
  providerId?: string;
  providerJobId?: string;
  retryCount: number;
  providerAttemptCount: number;
  publicErrorCode?: PublicErrorCode;
  publicErrorMessage?: string;
  internalDiagnostic?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  outputUrl?: string;
  outputUrlExpiresAt?: string;
  outputMimeType?: string;
  outputFileSize?: number;
  idempotencyKey?: string;
  requestFingerprint?: string;
  callbackUrl?: string;
  cancellationState?: string;
}

export interface StoredProviderAttempt {
  id: string;
  jobId: string;
  providerId: string;
  status: string;
  attemptNumber: number;
  providerJobId?: string;
  errorCode?: PublicErrorCode;
  retryable: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface StoredIncident {
  id: string;
  title: string;
  status: string;
  severity: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type { JobEvent };
