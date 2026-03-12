import type { Command } from "commander";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hashPassword, getPasswordHashHex, encryptEnvValues } from "../../gateway/safe-crypto.js";
import { validateStrongPassword } from "../../gateway/safe-password-policy.js";
import { isLoopbackAddress } from "../../gateway/net.js";
import { intro, note, outro, password as promptPw, isCancel } from "@clack/prompts";

function resolveCliPassword(args: { password?: string }): string | null {
  // If --password is given as an argument, use it directly.
  return typeof args.password === "string" && args.password.trim() ? args.password.trim() : null;
}

async function promptPassword(): Promise<string | null> {
  intro("safe-openclaw: set gateway password");

  const pw = await promptPw({
    message: "New password",
    validate: (v) => {
      if (!v) return "Password is required";
    },
  });
  if (isCancel(pw)) return null;

  const pw2 = await promptPw({
    message: "Confirm password",
  });
  if (isCancel(pw2)) return null;

  if (pw !== pw2) {
    console.error("Passwords do not match.");
    return null;
  }
  return pw;
}

export function registerSetPasswordCommand(program: Command) {
  program
    .command("set-password")
    .description(
      "safe-openclaw: Set or reset the gateway password (local-only). " +
        "Hashes the password (SHA-256) and AES-encrypts env tokens.",
    )
    .option("--password <password>", "New password (if not provided, will prompt)")
    .action(async (opts) => {
      // CLI set-password is allowed from SSH sessions since the user
      // has already authenticated to the host (e.g. key-based SSH).
      // The security boundary is the host itself, not the transport.

      const password = resolveCliPassword({ password: opts.password as string | undefined })
        ?? (await promptPassword());

      if (!password) {
        process.exit(1);
      }

      const validation = validateStrongPassword(password);
      if (!validation.valid) {
        console.error(`error: ${validation.error}`);
        process.exit(1);
      }

      const cfg: OpenClawConfig = loadConfig();

      // Hash password
      const passwordHashed = hashPassword(password);
      const newKeyHex = getPasswordHashHex(passwordHashed);

      // Determine old key for re-encryption (if password was previously set)
      const oldStoredPassword = cfg.gateway?.auth?.password;
      const oldKeyHex = oldStoredPassword ? getPasswordHashHex(oldStoredPassword) : undefined;

      // Encrypt env values
      const encryptedEnv = cfg.env
        ? encryptEnvValues(cfg.env as Record<string, unknown>, newKeyHex, oldKeyHex)
        : undefined;

      const nextCfg: OpenClawConfig = {
        ...cfg,
        env: encryptedEnv ?? cfg.env,
        gateway: {
          ...cfg.gateway,
          auth: {
            ...cfg.gateway?.auth,
            mode: "password" as const,
            token: undefined,
            password: passwordHashed,
          },
        },
      };

      try {
        await writeConfigFile(nextCfg);
        note(
          "Gateway password hashed and env tokens encrypted.\n" +
          "Restart the gateway for the change to take effect:\n\n" +
          "  openclaw gateway stop && openclaw gateway run",
        );
        outro("Done. Please restart the gateway.");
      } catch (err) {
        console.error(`error: failed to save config: ${String(err)}`);
        process.exit(1);
      }
    });
}
