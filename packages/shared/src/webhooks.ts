import { hmacSha256Hex, randomId, timingSafeEqual } from "./crypto";

export interface SignedWebhook {
  eventId: string;
  timestamp: string;
  signature: string;
  body: string;
}

export const signWebhookPayload = async (
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  eventId = randomId("evt", 20),
): Promise<SignedWebhook> => {
  const payload = `${eventId}.${timestamp}.${body}`;
  const signature = `v1=${await hmacSha256Hex(secret, payload)}`;
  return { eventId, timestamp, signature, body };
};

export const verifyWebhookSignature = async (
  secret: string,
  body: string,
  headers: Headers,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> => {
  const eventId = headers.get("EliteConverter-Event-Id") ?? headers.get("X-Provider-Event-Id");
  const timestamp = headers.get("EliteConverter-Timestamp") ?? headers.get("X-Provider-Timestamp");
  const signature = headers.get("EliteConverter-Signature") ?? headers.get("X-Provider-Signature");
  if (!eventId || !timestamp || !signature) return false;

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) return false;
  if (Math.abs(now - parsedTimestamp) > toleranceSeconds) return false;

  const expected = await signWebhookPayload(secret, body, timestamp, eventId);
  return timingSafeEqual(expected.signature, signature);
};

export const clientWebhookHeaders = (signed: SignedWebhook): HeadersInit => ({
  "Content-Type": "application/json",
  "EliteConverter-Event-Id": signed.eventId,
  "EliteConverter-Timestamp": signed.timestamp,
  "EliteConverter-Signature": signed.signature,
});
