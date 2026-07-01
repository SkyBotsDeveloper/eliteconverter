import {
  ApiFailure,
  ApiSuccess,
  PublicApiError,
  statusForError,
  toPublicError,
} from "@eliteconverter/shared";

export const ok = <T>(data: T, requestId: string, init?: ResponseInit): Response =>
  Response.json(
    {
      success: true,
      data,
      requestId,
    } satisfies ApiSuccess<T>,
    init,
  );

export const fail = (error: unknown, requestId: string): Response => {
  const publicError = toPublicError(error);
  return Response.json(
    {
      success: false,
      error: publicError,
      requestId,
    } satisfies ApiFailure,
    { status: statusForError(error) },
  );
};

export const parseJson = async <T>(request: Request, maxBytes = 16_384): Promise<T> => {
  const text = await request.text();
  if (text.length > maxBytes) throw new PublicApiError("validation_error", 413, "Body too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PublicApiError("validation_error", 400, "Malformed JSON");
  }
};

export const securityHeaders = (appEnv: string): Record<string, string> => ({
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src https://challenges.cloudflare.com; base-uri 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  ...(appEnv === "production"
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : {}),
});
