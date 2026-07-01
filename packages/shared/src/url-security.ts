import { PublicApiError } from "./catalog";
import type { PublicErrorCode } from "./schemas";

const ipv4PrivateRanges = [
  { start: "0.0.0.0", end: "0.255.255.255" },
  { start: "10.0.0.0", end: "10.255.255.255" },
  { start: "100.64.0.0", end: "100.127.255.255" },
  { start: "127.0.0.0", end: "127.255.255.255" },
  { start: "169.254.0.0", end: "169.254.255.255" },
  { start: "172.16.0.0", end: "172.31.255.255" },
  { start: "192.0.0.0", end: "192.0.0.255" },
  { start: "192.168.0.0", end: "192.168.255.255" },
  { start: "198.18.0.0", end: "198.19.255.255" },
  { start: "224.0.0.0", end: "255.255.255.255" },
];

const metadataHosts = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

export interface UrlValidationResult {
  url: string;
  redactedUrl: string;
  hostname: string;
}

const ipv4ToNumber = (input: string): number | null => {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
};

const normalizeNumericHost = (host: string): string | null => {
  const lower = host.toLowerCase();
  if (/^\d+$/.test(lower)) {
    const value = Number(lower);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
      return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(
        ".",
      );
    }
  }

  if (/^0x[0-9a-f]+$/i.test(lower)) {
    const value = Number.parseInt(lower.slice(2), 16);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
      return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(
        ".",
      );
    }
  }

  const octalLike = lower.match(/^0[0-7]+(?:\.0[0-7]+){0,3}$/);
  if (octalLike) return "127.0.0.1";

  return null;
};

export const isPrivateIpv4 = (host: string): boolean => {
  const normalized = normalizeNumericHost(host) ?? host;
  const numeric = ipv4ToNumber(normalized);
  if (numeric === null) return false;
  return ipv4PrivateRanges.some((range) => {
    const start = ipv4ToNumber(range.start);
    const end = ipv4ToNumber(range.end);
    return start !== null && end !== null && numeric >= start && numeric <= end;
  });
};

export const isBlockedIpv6 = (hostname: string): boolean => {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;
  if (value === "::1" || value === "::" || value.startsWith("fe80:")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("ff")) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ? isPrivateIpv4(mapped[1]) : false;
};

export const isBlockedHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (metadataHosts.has(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isPrivateIpv4(host) || isBlockedIpv6(host)) return true;
  return false;
};

export const redactUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|signature|secret|auth|expires|policy/i.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
};

const containsDrmHints = (url: URL): boolean => {
  const value = `${url.pathname} ${url.search}`.toLowerCase();
  return /\b(widevine|fairplay|playready|drm|license|keyformat|cenc)\b/.test(value);
};

export const validateExternalUrl = (
  rawUrl: string,
  errorCode: PublicErrorCode = "invalid_source_url",
): UrlValidationResult => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PublicApiError(errorCode, 400, "URL parsing failed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicApiError(errorCode, 400, "Unsupported URL protocol");
  }
  if (parsed.username || parsed.password) {
    throw new PublicApiError(errorCode, 400, "Embedded credentials are not allowed");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new PublicApiError(errorCode, 400, "Blocked hostname or IP range");
  }
  if (containsDrmHints(parsed)) {
    throw new PublicApiError("drm_protected_source", 400, "DRM hint detected");
  }

  return {
    url: parsed.toString(),
    redactedUrl: redactUrl(parsed.toString()),
    hostname: parsed.hostname.toLowerCase(),
  };
};

export interface RedirectValidationOptions {
  fetcher: typeof fetch;
  maxRedirects?: number;
  expectedContentTypes?: string[];
}

export const validateRedirectChain = async (
  rawUrl: string,
  options: RedirectValidationOptions,
): Promise<Response> => {
  let current = validateExternalUrl(rawUrl, "output_unavailable").url;
  const maxRedirects = options.maxRedirects ?? 3;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await options.fetcher(current, { method: "HEAD", redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location)
        throw new PublicApiError("output_unavailable", 502, "Missing redirect location");
      const next = new URL(location, current).toString();
      current = validateExternalUrl(next, "output_unavailable").url;
      continue;
    }
    const contentType = response.headers.get("content-type");
    if (
      options.expectedContentTypes?.length &&
      contentType &&
      !options.expectedContentTypes.some((type) => contentType.includes(type))
    ) {
      throw new PublicApiError("output_unavailable", 502, "Unexpected output content type");
    }
    return response;
  }

  throw new PublicApiError("output_unavailable", 502, "Too many redirects");
};
