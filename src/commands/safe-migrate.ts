/**
 * safe-openclaw: migrate command.
 *
 * Detects an existing openclaw installation and guides the user through
 * securing it with a password. Since safe-openclaw uses the same config
 * directory (~/.openclaw/) and config format as openclaw, no file migration
 * is needed. The only required step is setting up a password.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { validateStrongPassword } from "../gateway/safe-password-policy.js";

export type MigrateResult =
  | { status: "no-install" }
  | { status: "already-secure" }
  | { status: "needs-password"; configPath: string }
  | { status: "migrated"; configPath: string };

/**
 * Inspect the existing install and return what needs to be done.
 * Does not prompt or modify anything.
 */
export function inspectInstall(): MigrateResult {
  const stateDir = resolveStateDir();
  const configFile = path.join(stateDir, "openclaw.json");

  if (!existsSync(stateDir) && !existsSync(configFile)) {
    return { status: "no-install" };
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return { status: "no-install" };
  }

  const auth = cfg.gateway?.auth;
  const hasPassword =
    auth?.mode === "password" && typeof auth.password === "string" && auth.password.length > 0;

  if (hasPassword) {
    return { status: "already-secure" };
  }

  return { status: "needs-password", configPath: configFile };
}

/**
 * Apply a new password to the existing config.
 * Returns the config path that was written.
 */
export async function applyMigratePassword(password: string): Promise<string> {
  const stateDir = resolveStateDir();
  const configFile = path.join(stateDir, "openclaw.json");

  const validation = validateStrongPassword(password);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const cfg = loadConfig();
  const nextCfg = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        mode: "password" as const,
        token: undefined,
        password,
      },
    },
  };
  await writeConfigFile(nextCfg);
  return configFile;
}

/**
 * Print a human-readable migration status report.
 */
export function printMigrateStatus(result: MigrateResult): void {
  const stateDir = resolveStateDir();
  const homedir = os.homedir();
  const displayDir = stateDir.startsWith(homedir)
    ? "~" + stateDir.slice(homedir.length)
    : stateDir;

  switch (result.status) {
    case "no-install":
      console.log("No existing openclaw installation found.");
      console.log(`  Looked in: ${displayDir}`);
      console.log("  Run `safe-openclaw setup` to initialize a fresh install.");
      break;

    case "already-secure":
      console.log("✓ Gateway is already configured with password authentication.");
      console.log("  No migration needed.");
      break;

    case "needs-password":
      console.log("Found existing openclaw installation:");
      console.log(`  Config: ${result.configPath}`);
      console.log("");
      console.log("⚠  Gateway is using token auth with no password.");
      console.log("   Run `safe-openclaw set-password` to secure it,");
      console.log("   or `safe-openclaw migrate --set-password <pw>` to migrate non-interactively.");
      break;

    case "migrated":
      console.log("✓ Migration complete.");
      console.log(`  Config: ${result.configPath}`);
      console.log("  Gateway auth mode set to: password");
      console.log("  Restart the gateway for the change to take effect.");
      break;
  }
}
