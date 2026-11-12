import { createHmac, timingSafeEqual } from 'node:crypto';

/** Requests older or newer than this are refused (replay window). */
export const MAX_SKEW_MS = 60_000;

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('base64url');
}

/** Checks a service request's signature over its timestamp and JSON body. */
export function verify(secret: string, timestamp: number, body: string, signature: string, now = Date.now()): boolean {
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
