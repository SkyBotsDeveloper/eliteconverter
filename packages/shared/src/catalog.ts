import type { PublicError, PublicErrorCode } from "./schemas";

export const publicErrorCatalog: Record<PublicErrorCode, PublicError> = {
  invalid_source_url: {
    code: "invalid_source_url",
    message: "The supplied source URL is not valid.",
    retryable: false,
  },
  unsupported_source: {
    code: "unsupported_source",
    message: "The source is not supported by the configured providers.",
    retryable: false,
  },
  unsupported_format: {
    code: "unsupported_format",
    message: "The requested output format is not supported.",
    retryable: false,
  },
  unsupported_quality: {
    code: "unsupported_quality",
    message: "The requested quality is not supported.",
    retryable: false,
  },
  source_unreachable: {
    code: "source_unreachable",
    message: "The source could not be reached.",
    retryable: true,
  },
  source_expired: {
    code: "source_expired",
    message: "The source URL appears to have expired.",
    retryable: false,
  },
  source_authentication_required: {
    code: "source_authentication_required",
    message: "The source requires authentication that EliteConverter cannot provide.",
    retryable: false,
  },
  drm_protected_source: {
    code: "drm_protected_source",
    message: "DRM-protected sources are not supported.",
    retryable: false,
  },
  provider_timeout: {
    code: "provider_timeout",
    message: "The conversion provider timed out.",
    retryable: true,
  },
  provider_rate_limited: {
    code: "provider_rate_limited",
    message: "The conversion provider is temporarily rate limited.",
    retryable: true,
  },
  provider_temporary_failure: {
    code: "provider_temporary_failure",
    message: "The conversion provider reported a temporary failure.",
    retryable: true,
  },
  provider_permanent_failure: {
    code: "provider_permanent_failure",
    message: "The conversion provider rejected the conversion request.",
    retryable: false,
  },
  conversion_failed: {
    code: "conversion_failed",
    message: "The conversion failed.",
    retryable: false,
  },
  output_unavailable: {
    code: "output_unavailable",
    message: "The converted output is not available.",
    retryable: true,
  },
  output_expired: {
    code: "output_expired",
    message: "The output URL has expired.",
    retryable: true,
  },
  internal_configuration_error: {
    code: "internal_configuration_error",
    message: "The service is not configured correctly.",
    retryable: false,
  },
  internal_error: {
    code: "internal_error",
    message: "An internal error occurred.",
    retryable: true,
  },
  rate_limited: {
    code: "rate_limited",
    message: "Too many requests. Please try again later.",
    retryable: true,
  },
  unauthorized: {
    code: "unauthorized",
    message: "A valid API key is required.",
    retryable: false,
  },
  forbidden: {
    code: "forbidden",
    message: "The requested action is not allowed.",
    retryable: false,
  },
  idempotency_conflict: {
    code: "idempotency_conflict",
    message: "This idempotency key was already used with different request data.",
    retryable: false,
  },
  validation_error: {
    code: "validation_error",
    message: "The request payload is invalid.",
    retryable: false,
  },
  not_found: {
    code: "not_found",
    message: "The requested resource was not found.",
    retryable: false,
  },
};

export class PublicApiError extends Error {
  readonly publicError: PublicError;
  readonly status: number;
  readonly diagnostic?: string;

  constructor(code: PublicErrorCode, status = 400, diagnostic?: string) {
    super(publicErrorCatalog[code].message);
    this.name = "PublicApiError";
    this.publicError = publicErrorCatalog[code];
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

export const toPublicError = (error: unknown): PublicError => {
  if (error instanceof PublicApiError) {
    return error.publicError;
  }
  return publicErrorCatalog.internal_error;
};

export const statusForError = (error: unknown): number => {
  if (error instanceof PublicApiError) {
    return error.status;
  }
  return 500;
};

export const classifyProviderHttpStatus = (status: number): PublicErrorCode => {
  if (status === 401 || status === 403) return "source_authentication_required";
  if (status === 404) return "source_unreachable";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 409 || status === 415) return "unsupported_source";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_temporary_failure";
  return "provider_permanent_failure";
};

export const sanitizeDiagnostic = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/(authorization|cookie|api[-_]?key|token|signature)=?[^,\s&]*/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s]+/gi, (match) => {
      try {
        const url = new URL(match);
        return `${url.protocol}//${url.hostname}${url.pathname}`;
      } catch {
        return "<redacted-url>";
      }
    })
    .slice(0, 500);
};
