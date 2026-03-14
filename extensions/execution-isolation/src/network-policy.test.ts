import { describe, it, expect } from "vitest";
import { matchesNetworkPolicy, extractDomain, extractUrls } from "./network-policy.js";

describe("extractDomain", () => {
  it("extracts domain from URL", () => {
    expect(extractDomain("https://api.openai.com/v1/chat")).toBe("api.openai.com");
  });

  it("extracts domain from URL with port", () => {
    expect(extractDomain("http://localhost:3000/api")).toBe("localhost");
  });

  it("handles bare domain", () => {
    expect(extractDomain("example.com")).toBe("example.com");
  });

  it("lowercases domain", () => {
    expect(extractDomain("https://API.OpenAI.COM")).toBe("api.openai.com");
  });

  it("returns null for invalid input", () => {
    expect(extractDomain("")).toBe(null);
  });
});

describe("matchesNetworkPolicy", () => {
  it("allows all when allowAll is true", () => {
    const result = matchesNetworkPolicy("https://evil.com", { allowAll: true }, "deny");
    expect(result.allowed).toBe(true);
  });

  it("allows domains in allow list", () => {
    const result = matchesNetworkPolicy(
      "https://api.openai.com/v1/chat",
      {
        allow: ["api.openai.com", "api.anthropic.com"],
      },
      "deny",
    );
    expect(result.allowed).toBe(true);
  });

  it("denies domains in deny list", () => {
    const result = matchesNetworkPolicy(
      "https://evil.com/steal",
      {
        deny: ["evil.com"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("supports wildcard domain matching", () => {
    const result = matchesNetworkPolicy(
      "https://raw.githubusercontent.com/file",
      {
        allow: ["*.github.com", "*.githubusercontent.com"],
      },
      "deny",
    );
    expect(result.allowed).toBe(true);
  });

  it("wildcard matches exact domain too", () => {
    const result = matchesNetworkPolicy(
      "https://github.com",
      {
        allow: ["*.github.com"],
      },
      "deny",
    );
    expect(result.allowed).toBe(true);
  });

  it("deny takes precedence over allow", () => {
    const result = matchesNetworkPolicy(
      "https://evil.github.com",
      {
        allow: ["*.github.com"],
        deny: ["evil.github.com"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("denies domain not in allow list when allow list exists", () => {
    const result = matchesNetworkPolicy(
      "https://unknown-api.com",
      {
        allow: ["api.openai.com"],
      },
      "allow",
    );
    expect(result.allowed).toBe(false);
  });

  it("uses defaultAction when no rules match", () => {
    const allowResult = matchesNetworkPolicy("https://example.com", {}, "allow");
    expect(allowResult.allowed).toBe(true);

    const denyResult = matchesNetworkPolicy("https://example.com", {}, "deny");
    expect(denyResult.allowed).toBe(false);
  });
});

describe("extractUrls", () => {
  it("extracts from url key", () => {
    const urls = extractUrls({ url: "https://api.openai.com" });
    expect(urls).toEqual(["https://api.openai.com"]);
  });

  it("ignores non-URL strings", () => {
    const urls = extractUrls({ url: "not-a-url", other: "https://valid.com" });
    expect(urls).toHaveLength(0);
  });

  it("extracts from multiple URL keys", () => {
    const urls = extractUrls({
      url: "https://a.com",
      targetUrl: "https://b.com",
    });
    expect(urls).toHaveLength(2);
  });
});
