/**
 * Security Shield plugin for OpenClaw.
 *
 * Registers before_tool_call and after_tool_call hooks to:
 * 1. Block dangerous commands (rm -rf, curl|bash, reverse shells, etc.)
 * 2. Detect and redact secret leaks in tool output (API keys, tokens, etc.)
 * 3. Log all tool activity to an audit trail
 *
 * Works with all existing tools and extensions — no code changes required.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/security-shield";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/security-shield";
import { writeAuditEntry, type AuditEntry } from "./src/audit-log.js";
import { scanForDangerousCommands } from "./src/dangerous-commands.js";
import { scanForLeaks, redactLeaks } from "./src/leak-detector.js";

type ShieldConfig = {
  enforcement?: "block" | "warn" | "off";
  auditLog?: boolean;
  leakDetection?: boolean;
};

function resolveConfig(raw?: Record<string, unknown>): ShieldConfig {
  return {
    enforcement: (raw?.enforcement as ShieldConfig["enforcement"]) ?? "block",
    auditLog: raw?.auditLog !== false,
    leakDetection: raw?.leakDetection !== false,
  };
}

const plugin = {
  id: "security-shield",
  name: "Security Shield",
  description:
    "Blocks dangerous tool commands, detects secret leaks in tool output, and logs all tool activity.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

    logger.info(
      `Security Shield active (enforcement=${config.enforcement}, leakDetection=${config.leakDetection}, auditLog=${config.auditLog})`,
    );

    // ── before_tool_call: block dangerous commands ──────────────
    api.on("before_tool_call", (event) => {
      if (config.enforcement === "off") return;

      const paramsStr = JSON.stringify(event.params ?? {});
      const matches = scanForDangerousCommands(paramsStr);

      if (matches.length === 0) return;

      const criticals = matches.filter((m) => m.severity === "critical");
      const warnings = matches.filter((m) => m.severity === "warn");

      // Log all findings
      for (const m of matches) {
        const logMsg = `[Security Shield] ${m.severity.toUpperCase()}: ${m.message} (${m.ruleId}) in tool '${event.toolName}' — evidence: ${m.evidence}`;
        if (m.severity === "critical") {
          logger.warn(logMsg);
        } else {
          logger.info(logMsg);
        }
      }

      // Audit log
      if (config.auditLog) {
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          params: paramsStr,
          blocked: config.enforcement === "block" && criticals.length > 0,
          blockReason:
            criticals.length > 0 ? criticals.map((m) => m.message).join("; ") : undefined,
          findings: matches.map((m) => ({
            ruleId: m.ruleId,
            severity: m.severity,
            message: m.message,
          })),
        });
      }

      // Block critical matches in block mode
      if (config.enforcement === "block" && criticals.length > 0) {
        const reasons = criticals.map((m) => `• ${m.message} (${m.ruleId})`).join("\n");
        return {
          block: true,
          blockReason: `🛡️ Security Shield blocked this tool call:\n${reasons}\n\nIf this is intentional, ask the user to confirm.`,
        };
      }
    });

    // ── after_tool_call: detect leaks + audit log ───────────────
    api.on("after_tool_call", (event) => {
      const resultStr = event.result != null ? JSON.stringify(event.result) : "";
      const findings: AuditEntry["findings"] = [];

      // Leak detection
      if (config.leakDetection && resultStr.length > 0) {
        const leaks = scanForLeaks(resultStr);

        if (leaks.length > 0) {
          for (const leak of leaks) {
            logger.warn(
              `[Security Shield] LEAK DETECTED: ${leak.message} (${leak.ruleId}) in output of '${event.toolName}' — ${leak.evidence}`,
            );
            findings.push({
              ruleId: leak.ruleId,
              message: leak.message,
            });
          }
        }
      }

      // Audit log
      if (config.auditLog) {
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          params: JSON.stringify(event.params ?? {}),
          blocked: false,
          findings,
          durationMs: event.durationMs,
          error: event.error,
        });
      }
    });

    // ── message_sending: redact leaks in outbound messages ──────
    api.on("message_sending", (event) => {
      if (!config.leakDetection) return;

      const leaks = scanForLeaks(event.content);
      if (leaks.length === 0) return;

      for (const leak of leaks) {
        logger.warn(
          `[Security Shield] Redacting ${leak.message} (${leak.ruleId}) from outbound message`,
        );
      }

      return {
        content: redactLeaks(event.content),
      };
    });
  },
};

export default plugin;
