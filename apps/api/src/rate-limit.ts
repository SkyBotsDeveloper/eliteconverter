import { PublicApiError } from "@eliteconverter/shared";
import type { RequestContext } from "./types";

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

export const enforceRateLimit = async (
  key: string,
  context: RequestContext,
  limit = 60,
  windowMs = 60_000,
): Promise<void> => {
  if (context.env.RATE_LIMITER) {
    const result = await context.env.RATE_LIMITER.limit({ key });
    if (!result.success) throw new PublicApiError("rate_limited", 429);
    return;
  }

  const now = Date.now();
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new PublicApiError("rate_limited", 429);
  }
  bucket.count += 1;
};
