/**
 * safe-openclaw: password hashing and AES-256-GCM encryption for config secrets.
 *
 * - Passwords are stored as SHA-256 hashes (`sha256:<hex>`).
 * - Model API tokens in `config.env` are encrypted with AES-256-GCM,
 *   using the password hash (hex) as the 256-bit key.
 *   Format: `enc:v1:<base64(iv‖authTag‖ciphertext)>`
 */

import crypto from "node:crypto";

const HASH_PREFIX = "sha256:";
const ENC_PREFIX = "enc:v1:";

// ── Password hashing ─────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const hex = crypto.createHash("sha256").update(password).digest("hex");
  return `${HASH_PREFIX}${hex}`;
}

export function isPasswordHashed(value: string): boolean {
  return value.startsWith(HASH_PREFIX);
}

/**
 * Verify a plaintext password against a stored value.
 * Supports both hashed (`sha256:...`) and legacy plaintext passwords.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (isPasswordHashed(stored)) {
    const inputHash = hashPassword(password);
    if (inputHash.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(stored));
  }
  // Legacy plaintext comparison (constant-time)
  if (password.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(password), Buffer.from(stored));
}

/**
 * Extract the raw hex hash from a stored password value.
 * If the value is already hashed, strips the prefix.
 * If plaintext (legacy), hashes it first.
 */
export function getPasswordHashHex(stored: string): string {
  if (isPasswordHashed(stored)) {
    return stored.slice(HASH_PREFIX.length);
  }
  return crypto.createHash("sha256").update(stored).digest("hex");
}

// ── AES-256-GCM encryption ──────────────────────────────────────────────────

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @param plaintext - the value to encrypt
 * @param keyHex   - 64-char hex string (SHA-256 hash = 256 bits)
 */
export function encryptValue(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Pack: iv (12) + authTag (16) + ciphertext
  const combined = Buffer.concat([iv, tag, encrypted]);
  return `${ENC_PREFIX}${combined.toString("base64")}`;
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Returns the original plaintext if the value is not encrypted (no `enc:v1:` prefix).
 */
export function decryptValue(encrypted: string, keyHex: string): string {
  if (!isEncrypted(encrypted)) return encrypted;
  const key = Buffer.from(keyHex, "hex");
  const combined = Buffer.from(encrypted.slice(ENC_PREFIX.length), "base64");
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// ── Config env helpers ───────────────────────────────────────────────────────

/**
 * Encrypt all plaintext string values in a config `env` object.
 * Already-encrypted values are re-encrypted with the new key (decrypt first with oldKeyHex).
 */
export function encryptEnvValues(
  env: Record<string, unknown>,
  newKeyHex: string,
  oldKeyHex?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") {
      result[k] = v;
      continue;
    }
    if (isEncrypted(v) && !oldKeyHex) {
      // Already encrypted but no old key to decrypt — leave as-is to avoid double encryption
      result[k] = v;
      continue;
    }
    // Get plaintext: decrypt if already encrypted, otherwise use as-is
    const plaintext = isEncrypted(v) && oldKeyHex ? decryptValue(v, oldKeyHex) : v;
    result[k] = encryptValue(plaintext, newKeyHex);
  }
  return result;
}

/**
 * Decrypt all encrypted string values in a config `env` object.
 * Returns a map of env var name → plaintext value (only for encrypted entries).
 */
export function decryptEnvValues(
  env: Record<string, unknown>,
  keyHex: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && isEncrypted(v)) {
      result[k] = decryptValue(v, keyHex);
    }
  }
  return result;
}

