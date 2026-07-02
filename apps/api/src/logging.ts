import { redactUrl, sanitizeDiagnostic } from "@eliteconverter/shared";

export interface LogFields {
  requestId?: string;
  jobId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  errorCode?: string;
  retryCount?: number;
  queueDurationMs?: number;
  message?: string;
}

export const logInfo = (fields: LogFields): void => {
  console.log(JSON.stringify(redactLogFields({ level: "info", ...fields })));
};

export const logError = (fields: LogFields): void => {
  console.error(JSON.stringify(redactLogFields({ level: "error", ...fields })));
};

const redactLogFields = (fields: Record<string, unknown>): Record<string, unknown> => {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/authorization|cookie|api[-_]?key|token|secret|signature/i.test(key)) {
      redacted[key] = "<redacted>";
    } else if (key === "message" && typeof value === "string") {
      redacted[key] = sanitizeDiagnostic(value);
    } else if (typeof value === "string" && /^https?:\/\//.test(value)) {
      redacted[key] = redactUrl(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
};
