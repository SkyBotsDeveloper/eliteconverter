import {
  PublicApiError,
  createApiKey,
  hashApiKey,
  randomId,
  timingSafeEqual,
} from "@eliteconverter/shared";
import type { RequestContext, StoredApiKey } from "./types";

export interface AuthenticatedPrincipal {
  apiKey: StoredApiKey;
  scope: string;
}

export const authenticateApiKey = async (
  request: Request,
  context: RequestContext,
): Promise<AuthenticatedPrincipal> => {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value || !timingSafeEqual(scheme.toLowerCase(), "bearer")) {
    throw new PublicApiError("unauthorized", 401, "Missing bearer token");
  }
  if (!value.startsWith("ec_live_") && !value.startsWith("ec_test_")) {
    throw new PublicApiError("unauthorized", 401, "Invalid API key prefix");
  }

  const keyHash = await hashApiKey(value, context.config.apiKeyHashSecret);
  const apiKey = await context.repository.findApiKeyByHash(keyHash);
  if (!apiKey || apiKey.status !== "active") {
    throw new PublicApiError("unauthorized", 401, "API key not found or revoked");
  }
  await context.repository.updateApiKeyLastUsed(apiKey.id, new Date().toISOString());
  return { apiKey, scope: `api:${apiKey.id}` };
};

export const createStoredApiKey = async (
  name: string,
  ownerId: string,
  hashSecret: string,
  environment: "live" | "test" = "test",
): Promise<{ rawKey: string; stored: StoredApiKey }> => {
  const rawKey = createApiKey(environment);
  const keyHash = await hashApiKey(rawKey, hashSecret);
  return {
    rawKey,
    stored: {
      id: randomId("key", 20),
      ownerId,
      name,
      prefix: rawKey.slice(0, 12),
      keyHash,
      status: "active",
      scopes: ["conversions:create", "conversions:read", "conversions:cancel"],
      createdAt: new Date().toISOString(),
    },
  };
};
