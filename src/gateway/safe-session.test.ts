import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSessionToken, verifySessionToken } from "./safe-session.js";

const SECRET = "test-secret-abcdef1234567890";
const OTHER_SECRET = "other-secret-abcdef1234567890";

describe("issueSessionToken", () => {
  it("returns a non-empty string", () => {
    const token = issueSessionToken(SECRET);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("token contains exactly one dot separator", () => {
    const token = issueSessionToken(SECRET);
    const dots = token.split(".").length - 1;
    expect(dots).toBe(1);
  });

  it("two tokens issued at the same time differ in signature only due to timing", () => {
    // Both issued at same ms — payloads should be identical
    const now = Date.now();
    vi.setSystemTime(now);
    const t1 = issueSessionToken(SECRET);
    const t2 = issueSessionToken(SECRET);
    expect(t1).toBe(t2);
  });
});

describe("verifySessionToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies a freshly issued token", () => {
    const token = issueSessionToken(SECRET);
    const payload = verifySessionToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(typeof payload?.iat).toBe("number");
    expect(typeof payload?.exp).toBe("number");
  });

  it("exp is approximately 3 days after iat", () => {
    const token = issueSessionToken(SECRET);
    const payload = verifySessionToken(SECRET, token);
    expect(payload).not.toBeNull();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(payload!.exp - payload!.iat).toBe(threeDaysMs);
  });

  it("rejects token signed with wrong secret", () => {
    const token = issueSessionToken(SECRET);
    expect(verifySessionToken(OTHER_SECRET, token)).toBeNull();
  });

  it("rejects tampered payload", () => {
    const token = issueSessionToken(SECRET);
    const [payloadB64, sig] = token.split(".");
    // Tamper: modify the payload
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    payload.exp = payload.exp + 999999999;
    const tamperedB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = `${tamperedB64}.${sig}`;
    expect(verifySessionToken(SECRET, tamperedToken)).toBeNull();
  });

  it("rejects token with no dot", () => {
    expect(verifySessionToken(SECRET, "nodottoken")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifySessionToken(SECRET, "")).toBeNull();
  });

  it("rejects malformed payload (not valid JSON)", () => {
    const badPayload = Buffer.from("not-json").toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(badPayload).digest("base64url");
    expect(verifySessionToken(SECRET, `${badPayload}.${sig}`)).toBeNull();
  });

  it("rejects expired token", () => {
    const token = issueSessionToken(SECRET);
    // Advance time by 4 days
    vi.advanceTimersByTime(4 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(SECRET, token)).toBeNull();
  });

  it("accepts token just before expiry", () => {
    const token = issueSessionToken(SECRET);
    // Advance to just before 3-day expiry
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000 - 1000);
    expect(verifySessionToken(SECRET, token)).not.toBeNull();
  });
});
