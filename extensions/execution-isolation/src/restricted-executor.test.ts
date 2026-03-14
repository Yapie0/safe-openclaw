import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IsolationPolicy } from "./policy-types.js";
import { wrapCommand, generateSandboxProfile } from "./restricted-executor.js";

// Mock platform for cross-platform tests
const mockPlatform = vi.fn<() => NodeJS.Platform>();
vi.mock("node:os", () => ({
  platform: () => mockPlatform(),
}));

beforeEach(() => {
  mockPlatform.mockReturnValue("darwin");
});

describe("generateSandboxProfile", () => {
  it("returns null when no restrictions apply", () => {
    const policy: IsolationPolicy = { defaultAction: "allow" };
    expect(generateSandboxProfile(policy)).toBeNull();
  });

  it("generates deny-default profile with basic allows", () => {
    const policy: IsolationPolicy = { defaultAction: "deny" };
    const profile = generateSandboxProfile(policy);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-exec)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/bin"))');
  });

  it("adds deny rules for filesystem paths", () => {
    const policy: IsolationPolicy = {
      defaultAction: "allow",
      filesystem: { deny: ["/etc/passwd", "/var/secrets"] },
    };
    const profile = generateSandboxProfile(policy);
    expect(profile).toContain('(deny file-read* (subpath "/etc/passwd"))');
    expect(profile).toContain('(deny file-write* (subpath "/etc/passwd"))');
    expect(profile).toContain('(deny file-read* (subpath "/var/secrets"))');
    expect(profile).toContain('(deny file-write* (subpath "/var/secrets"))');
  });

  it("adds allow rules in deny-default mode", () => {
    const policy: IsolationPolicy = {
      defaultAction: "deny",
      filesystem: {
        readAllow: ["/tmp/workdir"],
        writeAllow: ["/tmp/workdir"],
      },
    };
    const profile = generateSandboxProfile(policy);
    expect(profile).toContain('(allow file-read* (subpath "/tmp/workdir"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/workdir"))');
  });

  it("adds network deny rules in deny-default mode", () => {
    const policy: IsolationPolicy = {
      defaultAction: "deny",
      network: { deny: ["evil.com"] },
    };
    const profile = generateSandboxProfile(policy);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(allow network* (local udp))");
  });
});

describe("wrapCommand", () => {
  describe("darwin", () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue("darwin");
    });

    it("wraps with sandbox-exec when restrictions apply", () => {
      const policy: IsolationPolicy = {
        defaultAction: "deny",
      };
      const result = wrapCommand("echo hello", policy);
      expect(result.wrappedCommand).toContain("sandbox-exec -p");
      expect(result.restrictions).toContain("sandbox-exec filesystem/network restrictions");
    });

    it("falls back to resource limits only when no sandbox needed", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        resources: { timeoutMs: 5000 },
      };
      const result = wrapCommand("echo hello", policy);
      expect(result.wrappedCommand).not.toContain("sandbox-exec");
      expect(result.wrappedCommand).toContain("timeout 5");
      expect(result.restrictions).toContain("timeout: 5s");
    });

    it("applies timeout to sandbox-wrapped commands", () => {
      const policy: IsolationPolicy = {
        defaultAction: "deny",
        resources: { timeoutMs: 10000 },
      };
      const result = wrapCommand("ls", policy);
      expect(result.wrappedCommand).toContain("sandbox-exec");
      expect(result.wrappedCommand).toContain("timeout 10");
    });
  });

  describe("linux", () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue("linux");
    });

    it("uses unshare for filesystem deny rules", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        filesystem: { deny: ["/etc/shadow"] },
      };
      const result = wrapCommand("cat /etc/shadow", policy);
      expect(result.wrappedCommand).toContain("unshare --mount --fork");
      expect(result.wrappedCommand).toContain("mount --bind /dev/null");
      expect(result.restrictions).toContain("mount namespace isolation (denied paths hidden)");
    });

    it("uses plain command when no filesystem deny rules", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        resources: { timeoutMs: 3000 },
      };
      const result = wrapCommand("echo hi", policy);
      expect(result.wrappedCommand).not.toContain("unshare");
      expect(result.wrappedCommand).toContain("timeout 3");
    });
  });

  describe("fallback (other platforms)", () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue("win32");
    });

    it("returns original command when no resources defined", () => {
      const policy: IsolationPolicy = { defaultAction: "allow" };
      const result = wrapCommand("echo hello", policy);
      expect(result.wrappedCommand).toBe("echo hello");
      expect(result.restrictions).toEqual([]);
    });

    it("applies timeout", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        resources: { timeoutMs: 2000 },
      };
      const result = wrapCommand("some-cmd", policy);
      expect(result.wrappedCommand).toContain("timeout 2");
      expect(result.restrictions).toContain("timeout: 2s");
    });

    it("applies max output bytes via ulimit", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        resources: { maxOutputBytes: 1048576 },
      };
      const result = wrapCommand("some-cmd", policy);
      expect(result.wrappedCommand).toContain("ulimit -f");
      expect(result.restrictions).toContain("max file size: 1048576 bytes");
    });

    it("applies both timeout and ulimit", () => {
      const policy: IsolationPolicy = {
        defaultAction: "allow",
        resources: { timeoutMs: 5000, maxOutputBytes: 512000 },
      };
      const result = wrapCommand("some-cmd", policy);
      expect(result.wrappedCommand).toContain("timeout 5");
      expect(result.wrappedCommand).toContain("ulimit -f");
      expect(result.restrictions.length).toBe(2);
    });
  });

  it("rounds timeout up to nearest second", () => {
    mockPlatform.mockReturnValue("win32");
    const policy: IsolationPolicy = {
      defaultAction: "allow",
      resources: { timeoutMs: 1500 },
    };
    const result = wrapCommand("cmd", policy);
    expect(result.wrappedCommand).toContain("timeout 2");
  });
});
