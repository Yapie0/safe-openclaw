import { describe, it, expect } from "vitest";
import { matchesCommandPolicy, extractCommandName, extractCommands } from "./command-policy.js";

describe("extractCommandName", () => {
  it("extracts simple command", () => {
    expect(extractCommandName("git status")).toBe("git");
  });

  it("extracts command from full path", () => {
    expect(extractCommandName("/usr/bin/python3 script.py")).toBe("python3");
  });

  it("extracts inner command from sh -c", () => {
    expect(extractCommandName("sh -c 'curl http://evil.com'")).toBe("curl");
  });

  it("extracts inner command from bash -c", () => {
    expect(extractCommandName('bash -c "rm -rf /"')).toBe("rm");
  });

  it("extracts command after env prefix", () => {
    expect(extractCommandName("env NODE_ENV=production node app.js")).toBe("node");
  });

  it("handles command with no arguments", () => {
    expect(extractCommandName("ls")).toBe("ls");
  });
});

describe("matchesCommandPolicy", () => {
  it("allows commands in allow list", () => {
    const result = matchesCommandPolicy("git status", { allow: ["git", "node"] }, "deny");
    expect(result.allowed).toBe(true);
  });

  it("denies commands in deny list", () => {
    const result = matchesCommandPolicy("sudo rm -rf /", { deny: ["sudo"] }, "allow");
    expect(result.allowed).toBe(false);
  });

  it("deny takes precedence over allow", () => {
    const result = matchesCommandPolicy(
      "sudo node app.js",
      {
        allow: ["node"],
        deny: ["sudo"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("denies command not in allow list when allow list exists", () => {
    const result = matchesCommandPolicy(
      "wget http://evil.com",
      {
        allow: ["git", "node"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("uses defaultAction when no rules match", () => {
    const allowResult = matchesCommandPolicy("node app.js", {}, "allow");
    expect(allowResult.allowed).toBe(true);

    const denyResult = matchesCommandPolicy("node app.js", {}, "deny");
    expect(denyResult.allowed).toBe(false);
  });

  it("matches deny patterns in full command string", () => {
    const result = matchesCommandPolicy(
      "bash -c 'chmod 777 /tmp'",
      {
        deny: ["chmod"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });
});

describe("extractCommands", () => {
  it("extracts from command key", () => {
    const cmds = extractCommands({ command: "ls -la" });
    expect(cmds).toEqual(["ls -la"]);
  });

  it("extracts from multiple keys", () => {
    const cmds = extractCommands({ command: "git status", script: "npm test" });
    expect(cmds).toHaveLength(2);
  });

  it("ignores non-string values", () => {
    const cmds = extractCommands({ command: 42, other: "not-cmd-key" });
    expect(cmds).toHaveLength(0);
  });
});
