import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { OUTPUT_REDACT_PLACEHOLDER, redactSecretsFromOutput } from "./safe-output-redact.js";

const P = OUTPUT_REDACT_PLACEHOLDER;

function cfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return overrides as OpenClawConfig;
}

describe("redactSecretsFromOutput", () => {
  // ── value-based redaction ────────────────────────────────────────────────

  it("redacts an API key present in config", () => {
    const config = cfg({ llm: { providers: [{ apiKey: "super-secret-api-key-1234" } as never] } });
    const result = redactSecretsFromOutput("Here is your key: super-secret-api-key-1234", config);
    expect(result).toBe(`Here is your key: ${P}`);
    expect(result).not.toContain("super-secret-api-key-1234");
  });

  it("redacts a gateway token present in config", () => {
    const config = cfg({ gateway: { auth: { mode: "token", token: "mySecretToken123" } } });
    const result = redactSecretsFromOutput("token is mySecretToken123 use it", config);
    expect(result).toBe(`token is ${P} use it`);
  });

  it("redacts the gateway password present in config", () => {
    const config = cfg({ gateway: { auth: { mode: "password", password: "Secure1Pass!" } } });
    const result = redactSecretsFromOutput("password is Secure1Pass!", config);
    expect(result).toBe(`password is ${P}`);
  });

  it("redacts multiple occurrences of the same secret", () => {
    const config = cfg({ gateway: { auth: { mode: "token", token: "tok-abc123456789" } } });
    const result = redactSecretsFromOutput("tok-abc123456789 and again tok-abc123456789", config);
    expect(result).toBe(`${P} and again ${P}`);
  });

  it("does not redact short values (below MIN_SECRET_LENGTH)", () => {
    const config = cfg({ gateway: { auth: { mode: "token", token: "short" } } });
    const result = redactSecretsFromOutput("the word short is fine", config);
    expect(result).toContain("short");
  });

  it("returns text unchanged when config has no secrets", () => {
    const result = redactSecretsFromOutput("hello world", cfg());
    expect(result).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(redactSecretsFromOutput("", cfg())).toBe("");
  });

  // ── pattern-based redaction ──────────────────────────────────────────────

  it("redacts OpenAI-style key via pattern even if not in config", () => {
    const result = redactSecretsFromOutput("key: sk-abcdefghijklmnopqrstuvwxyz123456", cfg());
    expect(result).toBe(`key: ${P}`);
    expect(result).not.toContain("sk-");
  });

  it("redacts Anthropic-style key via pattern", () => {
    const key = "sk-ant-" + "a".repeat(80);
    const result = redactSecretsFromOutput(`anthropic key: ${key}`, cfg());
    expect(result).toBe(`anthropic key: ${P}`);
  });

  it("redacts Telegram bot token via pattern", () => {
    const result = redactSecretsFromOutput(
      "bot token: 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg",
      cfg(),
    );
    expect(result).toBe(`bot token: ${P}`);
  });

  it("redacts Slack token via pattern", () => {
    const slackToken = ["xoxb", "0000000000000", "FAKEFAKEFAKEFA"].join("-");
    const result = redactSecretsFromOutput(`slack: ${slackToken}`, cfg());
    expect(result).toBe(`slack: ${P}`);
  });

  // ── combined ─────────────────────────────────────────────────────────────

  it("redacts both config value and pattern in same text", () => {
    const config = cfg({ gateway: { auth: { mode: "token", token: "my-custom-token-xyz" } } });
    const result = redactSecretsFromOutput(
      "config token: my-custom-token-xyz and openai: sk-abcdefghijklmnopqrstuvwxyz123456",
      config,
    );
    expect(result).toBe(`config token: ${P} and openai: ${P}`);
  });

  it("does not modify text with no secrets", () => {
    const config = cfg({ gateway: { auth: { mode: "password", password: "Secure1Pass!" } } });
    const text = "The weather today is sunny and warm.";
    expect(redactSecretsFromOutput(text, config)).toBe(text);
  });
});
