import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn((): OpenClawConfig => ({})),
  writeConfigFile: vi.fn(async (_cfg: OpenClawConfig) => {}),
  existsSync: vi.fn(() => true),
  resolveStateDir: vi.fn(() => "/home/user/.openclaw"),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: mocks.loadConfig, writeConfigFile: mocks.writeConfigFile };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mocks.existsSync, default: { ...actual, existsSync: mocks.existsSync } };
});

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return { ...actual, resolveStateDir: mocks.resolveStateDir };
});

import { applyMigratePassword, inspectInstall } from "./safe-migrate.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("inspectInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.resolveStateDir.mockReturnValue("/home/user/.openclaw");
  });

  it("returns no-install when state dir and config do not exist", () => {
    mocks.existsSync.mockReturnValue(false);
    const result = inspectInstall();
    expect(result.status).toBe("no-install");
  });

  it("returns no-install when loadConfig throws", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("config not found");
    });
    const result = inspectInstall();
    expect(result.status).toBe("no-install");
  });

  it("returns already-secure when password mode is configured", () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { auth: { mode: "password", password: "Secure1Pass" } },
    });
    const result = inspectInstall();
    expect(result.status).toBe("already-secure");
  });

  it("returns needs-password when auth mode is token (no password)", () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { auth: { mode: "token", token: "some-token" } },
    });
    const result = inspectInstall();
    expect(result.status).toBe("needs-password");
    if (result.status === "needs-password") {
      expect(result.configPath).toContain("openclaw.json");
    }
  });

  it("returns needs-password when no auth is configured", () => {
    mocks.loadConfig.mockReturnValue({});
    const result = inspectInstall();
    expect(result.status).toBe("needs-password");
  });

  it("returns needs-password when password field is empty string", () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { auth: { mode: "password", password: "" } },
    });
    const result = inspectInstall();
    expect(result.status).toBe("needs-password");
  });
});

describe("applyMigratePassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.writeConfigFile.mockResolvedValue(undefined);
    mocks.resolveStateDir.mockReturnValue("/home/user/.openclaw");
  });

  it("throws for a weak password", async () => {
    await expect(applyMigratePassword("weak")).rejects.toThrow();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("saves strong password in password mode", async () => {
    await applyMigratePassword("Secure1Pass");
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const saved = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(saved.gateway?.auth?.mode).toBe("password");
    expect(saved.gateway?.auth?.password).toBe("Secure1Pass");
  });

  it("clears existing token when setting password", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { auth: { mode: "token", token: "old-token" } },
    });
    await applyMigratePassword("Secure1Pass");
    const saved = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(saved.gateway?.auth?.token).toBeUndefined();
  });

  it("returns config file path", async () => {
    const configPath = await applyMigratePassword("Secure1Pass");
    expect(configPath).toContain("openclaw.json");
  });
});
