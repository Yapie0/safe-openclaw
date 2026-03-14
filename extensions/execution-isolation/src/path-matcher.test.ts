import { describe, it, expect } from "vitest";
import { matchesPathPolicy, extractPaths, expandPath } from "./path-matcher.js";

describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    const result = expandPath("~/Documents");
    expect(result).not.toContain("~");
    expect(result).toMatch(/\/Documents$/);
  });

  it("normalizes relative paths", () => {
    const result = expandPath("/foo/bar/../baz");
    expect(result).toBe("/foo/baz");
  });
});

describe("matchesPathPolicy", () => {
  it("denies paths in deny list", () => {
    const result = matchesPathPolicy(
      "/home/user/.ssh/id_rsa",
      {
        deny: ["/home/user/.ssh"],
      },
      "read",
      "allow",
    );
    expect(result.allowed).toBe(false);
    expect(result.component).toBe("filesystem");
  });

  it("allows paths in readAllow list", () => {
    const result = matchesPathPolicy(
      "/tmp/data.txt",
      {
        readAllow: ["/tmp"],
      },
      "read",
      "deny",
    );
    expect(result.allowed).toBe(true);
  });

  it("allows paths in writeAllow list for write operations", () => {
    const result = matchesPathPolicy(
      "/workspace/file.ts",
      {
        writeAllow: ["/workspace"],
      },
      "write",
      "deny",
    );
    expect(result.allowed).toBe(true);
  });

  it("denies write to read-only paths", () => {
    const result = matchesPathPolicy(
      "/readonly/file.ts",
      {
        readAllow: ["/readonly"],
      },
      "write",
      "deny",
    );
    // No writeAllow list, defaults to deny
    expect(result.allowed).toBe(false);
  });

  it("deny takes precedence over allow", () => {
    const result = matchesPathPolicy(
      "/home/user/.ssh/config",
      {
        readAllow: ["/home/user"],
        deny: ["/home/user/.ssh"],
      },
      "read",
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("uses defaultAction when no rules match", () => {
    const allowResult = matchesPathPolicy("/some/path", {}, "read", "allow");
    expect(allowResult.allowed).toBe(true);

    const denyResult = matchesPathPolicy("/some/path", {}, "read", "deny");
    expect(denyResult.allowed).toBe(false);
  });

  it("rejects path not in allow list when allow list exists", () => {
    const result = matchesPathPolicy(
      "/etc/passwd",
      {
        readAllow: ["/tmp", "/workspace"],
      },
      "read",
      "allow",
    );
    expect(result.allowed).toBe(false);
  });
});

describe("extractPaths", () => {
  it("extracts known path keys", () => {
    const paths = extractPaths({ path: "/foo/bar", other: "not-a-path" });
    expect(paths).toEqual(["/foo/bar"]);
  });

  it("extracts multiple path keys", () => {
    const paths = extractPaths({ file: "/a", directory: "/b", cwd: "/c" });
    expect(paths).toHaveLength(3);
  });

  it("ignores non-path values", () => {
    const paths = extractPaths({ path: "just-a-name", file: 42 });
    expect(paths).toHaveLength(0);
  });

  it("extracts relative paths starting with .", () => {
    const paths = extractPaths({ path: "./src/index.ts" });
    expect(paths).toEqual(["./src/index.ts"]);
  });

  it("extracts tilde paths", () => {
    const paths = extractPaths({ file: "~/.ssh/id_rsa" });
    expect(paths).toEqual(["~/.ssh/id_rsa"]);
  });
});
