import { describe, expect, it } from "vitest";
import { validateStrongPassword } from "./safe-password-policy.js";

describe("validateStrongPassword", () => {
  describe("valid passwords", () => {
    it("accepts a password with all requirements met", () => {
      expect(validateStrongPassword("Abcdef1!")).toEqual({ valid: true });
    });

    it("accepts exactly 8 characters", () => {
      expect(validateStrongPassword("Abcdef12")).toEqual({ valid: true });
    });

    it("accepts a long password", () => {
      expect(validateStrongPassword("MySecurePassword123")).toEqual({ valid: true });
    });

    it("accepts password with special characters", () => {
      expect(validateStrongPassword("P@ssw0rd!")).toEqual({ valid: true });
    });
  });

  describe("too short", () => {
    it("rejects empty string", () => {
      const result = validateStrongPassword("");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/8 characters/i);
      }
    });

    it("rejects 7-character password", () => {
      const result = validateStrongPassword("Abc1234");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/8 characters/i);
      }
    });
  });

  describe("missing uppercase", () => {
    it("rejects all-lowercase with digit", () => {
      const result = validateStrongPassword("abcdefg1");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/uppercase/i);
      }
    });
  });

  describe("missing lowercase", () => {
    it("rejects all-uppercase with digit", () => {
      const result = validateStrongPassword("ABCDEFG1");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/lowercase/i);
      }
    });
  });

  describe("missing digit", () => {
    it("rejects password with no digit", () => {
      const result = validateStrongPassword("Abcdefgh");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/digit/i);
      }
    });
  });

  describe("priority ordering", () => {
    it("reports length error before other errors", () => {
      // Short, no uppercase, no digit — length error takes priority
      const result = validateStrongPassword("abc");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/8 characters/i);
      }
    });
  });
});
