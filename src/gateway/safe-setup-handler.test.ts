import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { hashPassword, isPasswordHashed, isEncrypted } from "./safe-crypto.js";
import { issueSessionToken, verifySessionToken } from "./safe-session.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn((): OpenClawConfig => ({})),
  writeConfigFile: vi.fn(async (_cfg: OpenClawConfig) => {}),
  isLocalDirectRequest: vi.fn(() => true),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: mocks.loadConfig, writeConfigFile: mocks.writeConfigFile };
});

vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return { ...actual, isLocalDirectRequest: mocks.isLocalDirectRequest };
});

import { handleSafeAuthGate, hasValidSession } from "./safe-setup-handler.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = "test-session-secret-abcdef123456";
const CONFIG_PASSWORD = "Secure1Pass";

function makeReq(opts: {
  method?: string;
  url?: string;
  body?: unknown;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method: opts.method ?? "GET",
    url: opts.url ?? "/",
    headers: { host: "localhost", ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;

  if (opts.body !== undefined) {
    setImmediate(() => {
      emitter.emit("data", Buffer.from(JSON.stringify(opts.body)));
      emitter.emit("end");
    });
  } else {
    setImmediate(() => emitter.emit("end"));
  }
  return req;
}

function makeRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const headers: Record<string, string> = {};
  let body = "";
  let statusCode = 200;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    get _status() {
      return statusCode;
    },
    _headers: headers,
    get _body() {
      return body;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk) body = chunk;
    },
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
  return res;
}

function parsedBody(res: ReturnType<typeof makeRes>): Record<string, unknown> {
  return JSON.parse(res._body) as Record<string, unknown>;
}

function gateOpts(overrides?: Partial<Parameters<typeof handleSafeAuthGate>[2]>) {
  return {
    needsSetup: false,
    sessionSecret: SECRET,
    configPassword: CONFIG_PASSWORD,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleSafeAuthGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.isLocalDirectRequest.mockReturnValue(true);
  });

  // ── Auth gate: blocks unauthenticated requests ───────────────────────────

  describe("auth gate", () => {
    it("blocks unauthenticated HTML requests with login page", async () => {
      const req = makeReq({ url: "/", headers: { accept: "text/html" } });
      const res = makeRes();
      const handled = await handleSafeAuthGate(req, res, gateOpts());
      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect(res._body).toContain("Login");
      expect(res._body).toContain("safe-openclaw");
    });

    it("blocks unauthenticated API requests with 401", async () => {
      const req = makeReq({ url: "/api/something", headers: { accept: "application/json" } });
      const res = makeRes();
      const handled = await handleSafeAuthGate(req, res, gateOpts());
      expect(handled).toBe(true);
      expect(res._status).toBe(401);
    });

    it("allows authenticated requests through (cookie)", async () => {
      const token = issueSessionToken(SECRET);
      const req = makeReq({
        url: "/",
        headers: { cookie: `openclaw_session=${token}` },
      });
      const res = makeRes();
      const handled = await handleSafeAuthGate(req, res, gateOpts());
      expect(handled).toBe(false);
    });

    it("allows authenticated requests through (Bearer token)", async () => {
      const token = issueSessionToken(SECRET);
      const req = makeReq({
        url: "/",
        headers: { authorization: `Bearer ${token}` },
      });
      const res = makeRes();
      const handled = await handleSafeAuthGate(req, res, gateOpts());
      expect(handled).toBe(false);
    });

    it("allows health probes through without auth", async () => {
      for (const path of ["/health", "/healthz", "/ready", "/readyz"]) {
        const req = makeReq({ url: path });
        const res = makeRes();
        const handled = await handleSafeAuthGate(req, res, gateOpts());
        expect(handled).toBe(false);
      }
    });

    it("shows reset password button for local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(true);
      const req = makeReq({ url: "/", headers: { accept: "text/html" } });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._body).toContain("Reset password");
    });

    it("hides reset password button for remote requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({ url: "/", headers: { accept: "text/html" } });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._body).not.toContain("Reset password");
    });
  });

  // ── Setup mode ──────────────────────────────────────────────────────────

  describe("setup mode", () => {
    it("redirects local browser to /setup when needsSetup", async () => {
      const req = makeReq({ url: "/", headers: { accept: "text/html" } });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(302);
      expect(res._headers.location).toBe("/setup");
    });

    it("blocks remote requests when needsSetup", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({ url: "/anything" });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(403);
    });

    it("serves setup page at GET /setup for local requests", async () => {
      const req = makeReq({ url: "/setup", method: "GET" });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(200);
      expect(res._body).toContain("Set a password");
    });

    it("returns 403 for GET /setup from remote", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({ url: "/setup", method: "GET" });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(403);
    });
  });

  // ── POST /api/safe/setup ───────────────────────────────────────────────

  describe("POST /api/safe/setup", () => {
    it("saves password and returns session token", async () => {
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "Secure1Pass" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");
      expect(verifySessionToken(SECRET, body.token as string)).not.toBeNull();
      // Cookie should be set
      expect(res._headers["set-cookie"]).toContain("openclaw_session=");

      const savedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(savedCfg.gateway?.auth?.mode).toBe("password");
      expect(isPasswordHashed(savedCfg.gateway?.auth?.password as string)).toBe(true);
    });

    it("encrypts env values on setup", async () => {
      mocks.loadConfig.mockReturnValue({
        env: { API_KEY: "sk-test-12345678" },
      });
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "Secure1Pass" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));

      expect(res._status).toBe(200);
      const savedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      const savedEnv = savedCfg.env as Record<string, string>;
      expect(isEncrypted(savedEnv.API_KEY)).toBe(true);
    });

    it("returns 409 when already set up", async () => {
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "Secure1Pass" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: false }));
      expect(res._status).toBe(409);
    });

    it("returns 422 for weak password", async () => {
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "weak" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(422);
    });

    it("returns 403 for non-local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "Secure1Pass" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ needsSetup: true }));
      expect(res._status).toBe(403);
    });
  });

  // ── POST /api/safe/login ───────────────────────────────────────────────

  describe("POST /api/safe/login", () => {
    it("returns session token for correct password (plaintext stored)", async () => {
      const req = makeReq({
        url: "/api/safe/login",
        method: "POST",
        body: { password: CONFIG_PASSWORD },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");
      expect(verifySessionToken(SECRET, body.token as string)).not.toBeNull();
      expect(res._headers["set-cookie"]).toContain("openclaw_session=");
    });

    it("returns session token for correct password (hashed stored)", async () => {
      const hashedPassword = hashPassword(CONFIG_PASSWORD);
      const req = makeReq({
        url: "/api/safe/login",
        method: "POST",
        body: { password: CONFIG_PASSWORD },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts({ configPassword: hashedPassword }));

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
    });

    it("returns 401 for wrong password", async () => {
      const req = makeReq({
        url: "/api/safe/login",
        method: "POST",
        body: { password: "WrongPass1" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._status).toBe(401);
    });

    it("returns 400 for missing password", async () => {
      const req = makeReq({
        url: "/api/safe/login",
        method: "POST",
        body: {},
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._status).toBe(400);
    });
  });

  // ── POST /api/safe/reset-password ──────────────────────────────────────

  describe("POST /api/safe/reset-password", () => {
    it("returns 403 for non-local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "NewPass123" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._status).toBe(403);
    });

    it("resets password and returns session token", async () => {
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "NewSecure1" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");

      const savedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(isPasswordHashed(savedCfg.gateway?.auth?.password as string)).toBe(true);
    });

    it("returns 422 for weak password on reset", async () => {
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "weak" },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      expect(res._status).toBe(422);
    });
  });

  // ── GET /api/safe/auth-status ──────────────────────────────────────────

  describe("GET /api/safe/auth-status", () => {
    it("returns auth state for unauthenticated request", async () => {
      const req = makeReq({ url: "/api/safe/auth-status", method: "GET" });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(body.authenticated).toBe(false);
      expect(body.needsSetup).toBe(false);
    });

    it("returns authenticated=true for valid session", async () => {
      const token = issueSessionToken(SECRET);
      const req = makeReq({
        url: "/api/safe/auth-status",
        method: "GET",
        headers: { cookie: `openclaw_session=${token}` },
      });
      const res = makeRes();
      await handleSafeAuthGate(req, res, gateOpts());
      const body = parsedBody(res);
      expect(body.authenticated).toBe(true);
    });
  });

  // ── hasValidSession ────────────────────────────────────────────────────

  describe("hasValidSession", () => {
    it("returns true for valid cookie", () => {
      const token = issueSessionToken(SECRET);
      const req = makeReq({ headers: { cookie: `openclaw_session=${token}` } });
      expect(hasValidSession(req, SECRET)).toBe(true);
    });

    it("returns false for no session", () => {
      const req = makeReq({});
      expect(hasValidSession(req, SECRET)).toBe(false);
    });

    it("returns false for invalid token", () => {
      const req = makeReq({ headers: { cookie: "openclaw_session=garbage" } });
      expect(hasValidSession(req, SECRET)).toBe(false);
    });
  });
});
