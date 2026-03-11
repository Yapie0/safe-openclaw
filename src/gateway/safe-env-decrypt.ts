/**
 * safe-openclaw: decrypt encrypted env values at gateway startup.
 *
 * Called BEFORE loadConfig() so that process.env already has the decrypted
 * plaintext values.  When loadConfig() → applyConfigEnvVars() runs, it skips
 * env vars that are already present in process.env, so the encrypted config
 * values never overwrite the decrypted ones.
 */

import fs from "node:fs";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/config.js";
import { getPasswordHashHex, decryptEnvValues } from "./safe-crypto.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("safe-env-decrypt");

/**
 * Read the raw config file, decrypt any `enc:v1:...` values in the `env`
 * section, and inject the plaintext into `process.env`.
 *
 * Safe to call even when no encrypted values exist (no-op).
 */
export function decryptSafeEnvValues(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveConfigPath(), "utf8");
  } catch {
    return; // No config file yet (first-time setup)
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON5.parse(raw);
  } catch {
    return; // Malformed config — let loadConfig() report the error
  }

  const storedPassword = (cfg.gateway as Record<string, unknown> | undefined)
    ?.auth as Record<string, unknown> | undefined;
  const passwordValue = storedPassword?.password;
  if (typeof passwordValue !== "string" || !passwordValue) return;

  const env = cfg.env as Record<string, unknown> | undefined;
  if (!env) return;

  const keyHex = getPasswordHashHex(passwordValue);

  try {
    const decrypted = decryptEnvValues(env, keyHex);
    for (const [k, v] of Object.entries(decrypted)) {
      process.env[k] = v;
      log.debug(`Decrypted env var: ${k}`);
    }
  } catch (err) {
    log.warn(`Failed to decrypt env values: ${String(err)}`);
  }
}
