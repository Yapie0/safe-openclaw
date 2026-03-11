/**
 * Browser session tokens for safe-openclaw.
 * Issues HMAC-SHA256 signed tokens with 3-day expiry.
 * Tokens are returned to the browser and sent as Bearer tokens.
 */

import crypto from "node:crypto";

const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export type SessionTokenPayload = {
  iat: number; // issued at (ms)
  exp: number; // expires at (ms)
};

/**
 * Issue a new session token signed with the given secret.
 * Returns the token string to send to the client.
 */
export function issueSessionToken(secret: string): string {
  const now = Date.now();
  const payload: SessionTokenPayload = {
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a session token. Returns the payload if valid, null otherwise.
 */
export function verifySessionToken(
  secret: string,
  token: string,
): SessionTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = hmacSign(secret, payloadB64);
  // Constant-time comparison to prevent timing attacks
  if (!safeEqual(sig, expectedSig)) return null;

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return null; // expired
  }
  return payload;
}

function hmacSign(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

// Constant-time string comparison
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a dummy comparison to avoid timing leaks on length
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
