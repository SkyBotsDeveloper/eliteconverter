import type { PublicErrorCode } from "./schemas";

export interface RetryConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterRatio: number;
}

export const retryableErrorCodes = new Set<PublicErrorCode>([
  "source_unreachable",
  "provider_timeout",
  "provider_rate_limited",
  "provider_temporary_failure",
  "output_unavailable",
  "output_expired",
  "internal_error",
  "rate_limited",
]);

export const isRetryableError = (code: PublicErrorCode): boolean => retryableErrorCodes.has(code);

export const calculateBackoffMs = (
  attempt: number,
  config: RetryConfig,
  random = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
  const jitter = raw * config.jitterRatio * random();
  return Math.round(Math.min(raw + jitter, config.maxDelayMs));
};

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerSnapshot {
  providerId: string;
  state: CircuitState;
  consecutiveFailures: number;
  recentSuccesses: number;
  recentFailures: number;
  lastFailureAt?: string;
  cooldownUntil?: string;
  updatedAt: string;
}

export const nextCircuitState = (
  snapshot: CircuitBreakerSnapshot,
  event: "success" | "failure" | "probe",
  options: { threshold: number; cooldownSeconds: number; now?: Date },
): CircuitBreakerSnapshot => {
  const now = options.now ?? new Date();
  const updatedAt = now.toISOString();
  if (event === "success") {
    return {
      ...snapshot,
      state: "closed",
      consecutiveFailures: 0,
      recentSuccesses: snapshot.recentSuccesses + 1,
      updatedAt,
      cooldownUntil: undefined,
    };
  }

  if (event === "probe") {
    if (
      snapshot.state === "open" &&
      snapshot.cooldownUntil &&
      now >= new Date(snapshot.cooldownUntil)
    ) {
      return { ...snapshot, state: "half_open", updatedAt };
    }
    return { ...snapshot, updatedAt };
  }

  const failures = snapshot.consecutiveFailures + 1;
  const shouldOpen = failures >= options.threshold || snapshot.state === "half_open";
  const cooldownUntil = shouldOpen
    ? new Date(now.getTime() + options.cooldownSeconds * 1000).toISOString()
    : snapshot.cooldownUntil;

  return {
    ...snapshot,
    state: shouldOpen ? "open" : snapshot.state,
    consecutiveFailures: failures,
    recentFailures: snapshot.recentFailures + 1,
    lastFailureAt: updatedAt,
    cooldownUntil,
    updatedAt,
  };
};
