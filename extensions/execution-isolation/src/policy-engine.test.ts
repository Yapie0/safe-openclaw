import { describe, it, expect } from "vitest";
import { evaluateToolCall } from "./policy-engine.js";
import type { IsolationPolicy } from "./policy-types.js";

const basePolicy: IsolationPolicy = {
  defaultAction: "allow",
  filesystem: {
    readAllow: ["/workspace", "/tmp"],
    writeAllow: ["/workspace", "/tmp"],
    deny: ["~/.ssh", "~/.aws"],
  },
  network: {
    allow: ["api.openai.com", "api.anthropic.com"],
  },
  commands: {
    allow: ["git", "node", "pnpm", "npm"],
    deny: ["sudo", "chmod"],
  },
};

describe("evaluateToolCall", () => {
  it("allows a clean tool call with no extractable params", () => {
    const result = evaluateToolCall("some_tool", { message: "hello" }, basePolicy);
    expect(result.allowed).toBe(true);
    expect(result.evaluations).toHaveLength(0);
  });

  it("allows reading from allowed path", () => {
    const result = evaluateToolCall("read_file", { path: "/workspace/src/index.ts" }, basePolicy);
    expect(result.allowed).toBe(true);
  });

  it("denies reading from denied path", () => {
    const result = evaluateToolCall("read_file", { path: "~/.ssh/id_rsa" }, basePolicy);
    expect(result.allowed).toBe(false);
    expect(result.evaluations.some((e) => !e.allowed && e.component === "filesystem")).toBe(true);
  });

  it("allows command in allow list", () => {
    const result = evaluateToolCall("shell", { command: "git status" }, basePolicy);
    expect(result.allowed).toBe(true);
  });

  it("denies command in deny list", () => {
    const result = evaluateToolCall("shell", { command: "sudo rm -rf /" }, basePolicy);
    expect(result.allowed).toBe(false);
  });

  it("allows network request to allowed domain", () => {
    const result = evaluateToolCall(
      "http_request",
      { url: "https://api.openai.com/v1/chat" },
      basePolicy,
    );
    expect(result.allowed).toBe(true);
  });

  it("denies network request to unknown domain", () => {
    const result = evaluateToolCall("http_request", { url: "https://evil.com/exfil" }, basePolicy);
    expect(result.allowed).toBe(false);
  });

  it("applies tool-specific overrides", () => {
    const policy: IsolationPolicy = {
      ...basePolicy,
      toolOverrides: {
        special_tool: {
          commands: { allow: ["mycustomcmd"] },
        },
      },
    };
    const result = evaluateToolCall("special_tool", { command: "mycustomcmd --flag" }, policy);
    expect(result.allowed).toBe(true);
  });

  it("denies sudo even with tool override (builtin deny)", () => {
    const policy: IsolationPolicy = {
      ...basePolicy,
      toolOverrides: {
        special_tool: {
          commands: { allow: ["sudo"] },
        },
      },
    };
    const result = evaluateToolCall("special_tool", { command: "sudo whoami" }, policy);
    expect(result.allowed).toBe(false);
  });

  it("denies when any sub-evaluation denies", () => {
    const result = evaluateToolCall(
      "complex_tool",
      {
        command: "git push",
        path: "~/.ssh/id_rsa",
      },
      basePolicy,
    );
    expect(result.allowed).toBe(false);
  });

  it("respects deny-default mode", () => {
    const denyPolicy: IsolationPolicy = {
      defaultAction: "deny",
      commands: { allow: ["git"] },
    };
    // "obscurecmd" is not in builtin allow list, so it should be denied
    const result = evaluateToolCall("shell", { command: "obscurecmd --evil" }, denyPolicy);
    expect(result.allowed).toBe(false);
  });

  it("allows builtin-allowed commands in deny-default mode", () => {
    const denyPolicy: IsolationPolicy = {
      defaultAction: "deny",
      commands: { allow: [] },
    };
    const result = evaluateToolCall(
      "shell",
      { command: "curl https://api.github.com" },
      denyPolicy,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("evaluateToolCall with write detection", () => {
  it("detects write operations by tool name", () => {
    const policy: IsolationPolicy = {
      defaultAction: "deny",
      filesystem: {
        readAllow: ["/workspace"],
        // No writeAllow
      },
    };
    const result = evaluateToolCall(
      "write_file",
      { path: "/workspace/test.txt", content: "data" },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it("allows write when writeAllow matches", () => {
    const policy: IsolationPolicy = {
      defaultAction: "deny",
      filesystem: {
        writeAllow: ["/workspace"],
      },
    };
    const result = evaluateToolCall(
      "write_file",
      { path: "/workspace/test.txt", content: "data" },
      policy,
    );
    expect(result.allowed).toBe(true);
  });
});
