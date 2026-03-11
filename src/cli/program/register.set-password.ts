import type { Command } from "commander";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { validateStrongPassword } from "../../gateway/safe-password-policy.js";
import { isLoopbackAddress } from "../../gateway/net.js";
import { note, outro } from "@clack/prompts";

function resolveCliPassword(args: { password?: string }): string | null {
  // If --password is given as an argument, use it directly.
  return typeof args.password === "string" && args.password.trim() ? args.password.trim() : null;
}

async function promptPassword(): Promise<string | null> {
  // Avoid importing readline unless needed (CLI only).
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Hide input for passwords
  process.stdout.write("New password: ");
  const pw = await ask("");

  process.stdout.write("\nConfirm password: ");
  const pw2 = await ask("");
  process.stdout.write("\n");

  rl.close();
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
        "Switches gateway auth to password mode.",
    )
    .option("--password <password>", "New password (if not provided, will prompt)")
    .action(async (opts) => {
      // Guard: only allow from local machine
      const remoteAddr = (process.env.SSH_CLIENT ?? "").split(" ")[0] ?? "";
      if (remoteAddr && !isLoopbackAddress(remoteAddr)) {
        console.error(
          "error: set-password must be run directly on the gateway host, not over SSH.",
        );
        process.exit(1);
      }

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

      try {
        await writeConfigFile(nextCfg);
        note("Gateway password saved. Restart the gateway for the change to take effect.");
        outro("Done.");
      } catch (err) {
        console.error(`error: failed to save config: ${String(err)}`);
        process.exit(1);
      }
    });
}
