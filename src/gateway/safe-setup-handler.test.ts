import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { verifySessionToken } from "./safe-session.js";

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

import { handleSafeSetupRequest } from "./safe-setup-handler.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = "test-session-secret-abcdef123456";

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

  // Emit body as a data event on next tick so readJsonBody can consume it
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleSafeSetupRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.isLocalDirectRequest.mockReturnValue(true);
  });

  // ── Returns false for unrelated paths ─────────────────────────────────────

  it("returns false for unrelated paths", async () => {
    const req = makeReq({ url: "/api/other" });
    const res = makeRes();
    const handled = await handleSafeSetupRequest(req, res, {
      needsSetup: true,
      sessionSecret: SECRET,
    });
    expect(handled).toBe(false);
  });

  // ── GET /setup ─────────────────────────────────────────────────────────────

  describe("GET /setup", () => {
    it("serves setup page for local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(true);
      const req = makeReq({ url: "/setup", method: "GET" });
      const res = makeRes();
      const handled = await handleSafeSetupRequest(req, res, {
        needsSetup: true,
        sessionSecret: SECRET,
      });
      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toMatch(/text\/html/);
      expect(res._body).toContain("safe-openclaw");
    });

    it("returns 403 for non-local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({ url: "/setup", method: "GET" });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(403);
      expect(parsedBody(res).ok).toBe(false);
    });
  });

  // ── POST /api/safe/setup ───────────────────────────────────────────────────

  describe("POST /api/safe/setup", () => {
    it("returns 403 for non-local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { password: "Abc12345" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(403);
    });

    it("returns 409 when setup is already done (needsSetup=false)", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(true);
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { password: "Abc12345" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: false, sessionSecret: SECRET });
      expect(res._status).toBe(409);
      expect(parsedBody(res).ok).toBe(false);
    });

    it("returns 422 for weak password (too short)", async () => {
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { password: "Abc1" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(422);
      expect(parsedBody(res).ok).toBe(false);
    });

    it("returns 422 for weak password (no uppercase)", async () => {
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { password: "abcdefg1" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(422);
    });

    it("returns 422 for weak password (no digit)", async () => {
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { password: "Abcdefgh" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(422);
    });

    it("returns 400 for missing password field", async () => {
      const req = makeReq({ url: "/api/safe/setup", method: "POST", body: { other: "field" } });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(400);
    });

    it("saves password to config and returns session token on success", async () => {
      const req = makeReq({
        url: "/api/safe/setup",
        method: "POST",
        body: { password: "Secure1Pass" },
      });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");

      // Token must be verifiable
      expect(verifySessionToken(SECRET, body.token as string)).not.toBeNull();

      // Config must have been written with password mode
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const savedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(savedCfg.gateway?.auth?.mode).toBe("password");
      expect(savedCfg.gateway?.auth?.password).toBe("Secure1Pass");
      // Auto-generated token must be cleared
      expect(savedCfg.gateway?.auth?.token).toBeUndefined();
    });

    it("returns 400 for invalid JSON body", async () => {
      const emitter = new EventEmitter();
      const req = Object.assign(emitter, {
        method: "POST",
        url: "/api/safe/setup",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      }) as unknown as IncomingMessage;
      setImmediate(() => {
        emitter.emit("data", Buffer.from("not-json{{{"));
        emitter.emit("end");
      });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: true, sessionSecret: SECRET });
      expect(res._status).toBe(400);
    });
  });

  // ── POST /api/safe/reset-password ─────────────────────────────────────────

  describe("POST /api/safe/reset-password", () => {
    it("returns 403 for non-local requests", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(false);
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "NewPass123" },
      });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: false, sessionSecret: SECRET });
      expect(res._status).toBe(403);
    });

    it("resets password even when needsSetup=false", async () => {
      mocks.isLocalDirectRequest.mockReturnValue(true);
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "NewSecure1" },
      });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: false, sessionSecret: SECRET });

      expect(res._status).toBe(200);
      const body = parsedBody(res);
      expect(body.ok).toBe(true);
      expect(typeof body.token).toBe("string");
      expect(verifySessionToken(SECRET, body.token as string)).not.toBeNull();

      const savedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(savedCfg.gateway?.auth?.password).toBe("NewSecure1");
    });

    it("returns 422 for weak password on reset", async () => {
      const req = makeReq({
        url: "/api/safe/reset-password",
        method: "POST",
        body: { password: "weak" },
      });
      const res = makeRes();
      await handleSafeSetupRequest(req, res, { needsSetup: false, sessionSecret: SECRET });
      expect(res._status).toBe(422);
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });
  });
});
