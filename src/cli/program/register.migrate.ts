import type { Command } from "commander";
import {
  applyMigratePassword,
  inspectInstall,
  printMigrateStatus,
} from "../../commands/safe-migrate.js";

export function registerMigrateCommand(program: Command) {
  program
    .command("migrate")
    .description(
      "safe-openclaw: detect existing openclaw install and set a gateway password",
    )
    .option(
      "--set-password <password>",
      "Set this password non-interactively (must meet strength requirements)",
    )
    .option("--check", "Only report migration status, make no changes", false)
    .action(async (opts) => {
      const result = inspectInstall();

      if (opts.check || result.status === "no-install" || result.status === "already-secure") {
        printMigrateStatus(result);
        return;
      }

      // result.status === "needs-password"
      if (opts.setPassword) {
        // Non-interactive path
        try {
          const configPath = await applyMigratePassword(opts.setPassword as string);
          printMigrateStatus({ status: "migrated", configPath });
        } catch (err) {
          console.error(`error: ${String(err)}`);
          process.exit(1);
        }
        return;
      }

      // Interactive path: show status and guide user
      printMigrateStatus(result);
    });
}
