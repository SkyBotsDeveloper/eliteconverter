import { PublicApiError, outputFormats, qualityOptions } from "@eliteconverter/shared";
import type { AppConfig, Env } from "./types";

const readNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readList = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const requireSecret = (env: Env, key: keyof Env, fallback: string, appEnv: string): string => {
  const value = env[key];
  if (typeof value === "string" && value.trim()) return value;
  if (appEnv === "production") {
    throw new PublicApiError("internal_configuration_error", 500, `Missing ${String(key)}`);
  }
  return fallback;
};

export const getConfig = (env: Env): AppConfig => {
  const appEnv = normalizeEnv(env.APP_ENV);
  return {
    appEnv,
    appBaseUrl: env.APP_BASE_URL ?? "http://127.0.0.1:8787",
    apiBaseUrl: env.API_BASE_URL ?? "http://127.0.0.1:8787/api/v1",
    corsAllowedOrigins: readList(env.CORS_ALLOWED_ORIGINS, [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]),
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
    apiKeyHashSecret: requireSecret(
      env,
      "API_KEY_HASH_SECRET",
      "test-only-api-key-hash-secret",
      appEnv,
    ),
    clientWebhookSigningSecret: requireSecret(
      env,
      "CLIENT_WEBHOOK_SIGNING_SECRET",
      "test-only-client-webhook-secret",
      appEnv,
    ),
    enabledProviders: readList(env.ENABLED_PROVIDERS, ["mock"]),
    providerPriority: readList(env.PROVIDER_PRIORITY, ["mock"]),
    mockProviderFormats: readEnumList(env.MOCK_PROVIDER_FORMATS, outputFormats, [...outputFormats]),
    mockProviderQualities: readEnumList(env.MOCK_PROVIDER_QUALITIES, qualityOptions, [
      ...qualityOptions,
    ]),
    genericProvider: {
      baseUrl: env.GENERIC_PROVIDER_BASE_URL ?? "",
      apiKey: env.GENERIC_PROVIDER_API_KEY ?? "",
      authHeader: env.GENERIC_PROVIDER_AUTH_HEADER ?? "Authorization",
      authScheme: env.GENERIC_PROVIDER_AUTH_SCHEME ?? "Bearer",
      createPath: env.GENERIC_PROVIDER_CREATE_PATH ?? "/jobs",
      statusPath: env.GENERIC_PROVIDER_STATUS_PATH ?? "/jobs/{id}",
      cancelPath: env.GENERIC_PROVIDER_CANCEL_PATH || undefined,
      refreshPath: env.GENERIC_PROVIDER_REFRESH_PATH || undefined,
      webhookSecret: env.GENERIC_PROVIDER_WEBHOOK_SECRET || undefined,
      timeoutMs: readNumber(env.GENERIC_PROVIDER_TIMEOUT_MS, 10000),
    },
    cloudConvertProvider: {
      baseUrl: env.CLOUDCONVERT_BASE_URL ?? "https://api.cloudconvert.com/v2",
      apiKey: env.CLOUDCONVERT_API_KEY ?? "",
      webhookSigningSecret: env.CLOUDCONVERT_WEBHOOK_SIGNING_SECRET || undefined,
      formats: readEnumList(env.CLOUDCONVERT_FORMATS, outputFormats, ["mp4", "webm", "mkv"]),
      qualities: readEnumList(env.CLOUDCONVERT_QUALITIES, qualityOptions, ["source"]),
      timeoutMs: readNumber(env.CLOUDCONVERT_TIMEOUT_MS, 10000),
    },
    maxProviderAttempts: readNumber(env.MAX_PROVIDER_ATTEMPTS, 3),
    maxRetryAttempts: readNumber(env.MAX_RETRY_ATTEMPTS, 3),
    initialRetryDelayMs: readNumber(env.INITIAL_RETRY_DELAY_MS, 1000),
    maxRetryDelayMs: readNumber(env.MAX_RETRY_DELAY_MS, 60000),
    jobExpirationHours: readNumber(env.JOB_EXPIRATION_HOURS, 24),
    staleJobThresholdMinutes: readNumber(env.STUCK_JOB_THRESHOLD_MINUTES, 15),
    circuitBreakerThreshold: readNumber(env.CIRCUIT_BREAKER_THRESHOLD, 3),
    circuitBreakerCooldownSeconds: readNumber(env.CIRCUIT_BREAKER_COOLDOWN_SECONDS, 60),
    maxConcurrentJobsPerUser: readNumber(env.MAX_CONCURRENT_JOBS_PER_USER, 5),
    maxAnonymousJobsPerDay: readNumber(env.MAX_ANONYMOUS_JOBS_PER_DAY, 20),
    callbackHostAllowlist: readList(env.CALLBACK_HOST_ALLOWLIST, []),
    clientWebhookMaxAttempts: readNumber(env.CLIENT_WEBHOOK_MAX_ATTEMPTS, 8),
  };
};

const readEnumList = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T[],
): T[] => {
  const list = readList(value, fallback);
  return list.filter((item): item is T => allowed.includes(item as T));
};

const normalizeEnv = (value: string | undefined): AppConfig["appEnv"] => {
  if (value === "production" || value === "staging" || value === "test") return value;
  return "development";
};
