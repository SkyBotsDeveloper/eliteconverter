import { PublicApiError } from "@eliteconverter/shared";
import type { RequestContext } from "./types";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

export const validateTurnstile = async (
  token: string,
  remoteIp: string | undefined,
  context: RequestContext,
): Promise<void> => {
  if (context.config.appEnv !== "production" && isAcceptedTestToken(token)) return;
  const secret = context.config.turnstileSecretKey;
  if (!secret) {
    throw new PublicApiError("internal_configuration_error", 500, "Missing Turnstile secret");
  }

  const formData = new FormData();
  formData.set("secret", secret);
  formData.set("response", token);
  if (remoteIp) formData.set("remoteip", remoteIp);

  const response = await context.fetcher(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: formData,
    },
  );
  const result = (await response.json()) as TurnstileResponse;
  if (!result.success) {
    throw new PublicApiError(
      "forbidden",
      403,
      result["error-codes"]?.join(",") ?? "Turnstile failed",
    );
  }
};

const isAcceptedTestToken = (token: string): boolean =>
  token === "test-pass" || token === "XXXX.DUMMY.TOKEN.XXXX";
