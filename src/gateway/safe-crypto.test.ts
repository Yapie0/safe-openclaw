import { describe, expect, it } from "vitest";
import {
  hashPassword,
  isPasswordHashed,
  verifyPassword,
  getPasswordHashHex,
  encryptValue,
  decryptValue,
  isEncrypted,
  encryptEnvValues,
  decryptEnvValues,
} from "./safe-crypto.js";

describe("safe-crypto", () => {
  // ── Password hashing ────────────────────────────────────────────────────

  describe("hashPassword", () => {
    it("returns sha256-prefixed hex", () => {
      const h = hashPassword("Test1234");
      expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      expect(hashPassword("abc")).toBe(hashPassword("abc"));
    });

    it("differs for different inputs", () => {
      expect(hashPassword("abc")).not.toBe(hashPassword("xyz"));
    });
  });

  describe("isPasswordHashed", () => {
    it("true for hashed value", () => {
      expect(isPasswordHashed("sha256:abc123")).toBe(true);
    });
    it("false for plaintext", () => {
      expect(isPasswordHashed("MyPassword1")).toBe(false);
    });
  });

  describe("verifyPassword", () => {
    it("verifies against hashed value", () => {
      const stored = hashPassword("Domore0325");
      expect(verifyPassword("Domore0325", stored)).toBe(true);
      expect(verifyPassword("wrong", stored)).toBe(false);
    });

    it("verifies against legacy plaintext", () => {
      expect(verifyPassword("Domore0325", "Domore0325")).toBe(true);
      expect(verifyPassword("wrong", "Domore0325")).toBe(false);
    });

    it("rejects different-length plaintext without timing leak", () => {
      expect(verifyPassword("short", "muchlongerpassword")).toBe(false);
    });
  });

  describe("getPasswordHashHex", () => {
    it("strips prefix from hashed value", () => {
      const h = hashPassword("test");
      const hex = getPasswordHashHex(h);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expect(h).toBe(`sha256:${hex}`);
    });

    it("hashes plaintext and returns hex", () => {
      const hex = getPasswordHashHex("test");
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expect(hex).toBe(getPasswordHashHex(hashPassword("test")));
    });
  });

  // ── AES encryption ──────────────────────────────────────────────────────

  const testKeyHex = getPasswordHashHex("TestPassword1");

  describe("encryptValue / decryptValue", () => {
    it("round-trips correctly", () => {
      const plaintext = "sk-sp-a7d7b85c31f945789de943c90022c361";
      const encrypted = encryptValue(plaintext, testKeyHex);
      expect(encrypted).toMatch(/^enc:v1:/);
      expect(decryptValue(encrypted, testKeyHex)).toBe(plaintext);
    });

    it("produces different ciphertext each time (random IV)", () => {
      const a = encryptValue("same", testKeyHex);
      const b = encryptValue("same", testKeyHex);
      expect(a).not.toBe(b);
      // Both decrypt to the same value
      expect(decryptValue(a, testKeyHex)).toBe("same");
      expect(decryptValue(b, testKeyHex)).toBe("same");
    });

    it("fails with wrong key", () => {
      const encrypted = encryptValue("secret", testKeyHex);
      const wrongKey = getPasswordHashHex("WrongPassword1");
      expect(() => decryptValue(encrypted, wrongKey)).toThrow();
    });

    it("returns plaintext as-is when not encrypted", () => {
      expect(decryptValue("not-encrypted", testKeyHex)).toBe("not-encrypted");
    });
  });

  describe("isEncrypted", () => {
    it("true for encrypted value", () => {
      expect(isEncrypted("enc:v1:abc")).toBe(true);
    });
    it("false for plaintext", () => {
      expect(isEncrypted("sk-abc123")).toBe(false);
    });
  });

  // ── Config env helpers ──────────────────────────────────────────────────

  describe("encryptEnvValues", () => {
    it("encrypts all string values", () => {
      const env = { API_KEY: "sk-abc", OTHER: "value123" };
      const result = encryptEnvValues(env, testKeyHex);
      expect(isEncrypted(result.API_KEY as string)).toBe(true);
      expect(isEncrypted(result.OTHER as string)).toBe(true);
    });

    it("skips non-string values", () => {
      const env = { KEY: "secret", nested: { a: 1 } } as Record<string, unknown>;
      const result = encryptEnvValues(env, testKeyHex);
      expect(isEncrypted(result.KEY as string)).toBe(true);
      expect(result.nested).toEqual({ a: 1 });
    });

    it("re-encrypts with new key when oldKeyHex provided", () => {
      const oldKey = getPasswordHashHex("OldPassword1");
      const newKey = getPasswordHashHex("NewPassword1");
      const env = { TOKEN: encryptValue("my-secret", oldKey) };
      const result = encryptEnvValues(env, newKey, oldKey);
      // Decrypt with new key should work
      expect(decryptValue(result.TOKEN as string, newKey)).toBe("my-secret");
      // Old key should fail
      expect(() => decryptValue(result.TOKEN as string, oldKey)).toThrow();
    });
  });

  describe("decryptEnvValues", () => {
    it("decrypts only encrypted entries", () => {
      const env = {
        ENCRYPTED: encryptValue("secret-val", testKeyHex),
        PLAIN: "not-encrypted",
      };
      const result = decryptEnvValues(env, testKeyHex);
      expect(result.ENCRYPTED).toBe("secret-val");
      expect(result.PLAIN).toBeUndefined(); // plaintext entries not included
    });
  });
});
