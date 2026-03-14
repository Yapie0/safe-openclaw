/**
 * Execution Isolation plugin for OpenClaw.
 *
 * Registers before_tool_call hooks to enforce permission policies:
 * 1. Filesystem access control (read/write allow/deny lists)
 * 2. Network domain control (allow/deny lists)
 * 3. Command binary control (allow/deny lists)
 * 4. Audit logging of all policy decisions
 *
 * Works alongside Security Shield — Shield catches pattern-based attacks,
 * Isolation enforces structural access control.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeAuditEntry } from "./src/audit.js";
import { evaluateToolCall } from "./src/policy-engine.js";
import type { IsolationPolicy } from "./src/policy-types.js";
import { wrapCommand } from "./src/restricted-executor.js";

type IsolationConfig = {
  enforcement: "block" | "warn" | "off";
  defaultAction: "allow" | "deny";
  auditLog: boolean;
  filesystem?: IsolationPolicy["filesystem"];
  network?: IsolationPolicy["network"];
  commands?: IsolationPolicy["commands"];
  resources?: IsolationPolicy["resources"];
  toolOverrides?: IsolationPolicy["toolOverrides"];
};

function resolveConfig(raw?: Record<string, unknown>): IsolationConfig {
  return {
    enforcement: (raw?.enforcement as IsolationConfig["enforcement"]) ?? "block",
    defaultAction: (raw?.defaultAction as IsolationConfig["defaultAction"]) ?? "allow",
    auditLog: raw?.auditLog !== false,
    filesystem: raw?.filesystem as IsolationConfig["filesystem"],
    network: raw?.network as IsolationConfig["network"],
    commands: raw?.commands as IsolationConfig["commands"],
    resources: raw?.resources as IsolationConfig["resources"],
    toolOverrides: raw?.toolOverrides as IsolationConfig["toolOverrides"],
  };
}

function buildPolicy(config: IsolationConfig): IsolationPolicy {
  return {
    defaultAction: config.defaultAction,
    filesystem: config.filesystem,
    network: config.network,
    commands: config.commands,
    resources: config.resources,
    toolOverrides: config.toolOverrides,
  };
}

/** Redact long param values for audit logs. */
function redactParams(params: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 200) {
      redacted[key] = value.slice(0, 100) + `...[${value.length} chars]`;
    } else {
      redacted[key] = value;
    }
  }
  return JSON.stringify(redacted);
}

/** Tool names that execute shell commands and can be wrapped. */
const EXEC_TOOL_NAMES = new Set(["exec", "bash", "shell", "terminal", "run"]);

function isExecTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return EXEC_TOOL_NAMES.has(lower) || lower.includes("exec") || lower.includes("bash");
}

const plugin = {
  id: "execution-isolation",
  name: "Execution Isolation",
  description:
    "Permission-based access control for AI tool calls. Enforces filesystem, network, and command policies with audit logging.",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      enforcement: { type: "string" as const, enum: ["block", "warn", "off"], default: "block" },
      defaultAction: { type: "string" as const, enum: ["allow", "deny"], default: "allow" },
      auditLog: { type: "boolean" as const, default: true },
      filesystem: { type: "object" as const },
      network: { type: "object" as const },
      commands: { type: "object" as const },
      resources: { type: "object" as const },
      toolOverrides: { type: "object" as const },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;
    const policy = buildPolicy(config);

    logger.info(
      `Execution Isolation active (enforcement=${config.enforcement}, default=${config.defaultAction}, audit=${config.auditLog})`,
    );

    // ── before_tool_call: enforce policy ──────────────────────
    api.on("before_tool_call", (event) => {
      if (config.enforcement === "off") return;

      const result = evaluateToolCall(event.toolName, event.params ?? {}, policy);

      // Log evaluations
      for (const ev of result.evaluations) {
        const level = ev.allowed ? "info" : "warn";
        const msg = `[Execution Isolation] ${ev.allowed ? "ALLOW" : "DENY"}: ${ev.reason} (${ev.component}) in tool '${event.toolName}'`;
        if (level === "warn") {
          logger.warn(msg);
        } else {
          logger.info(msg);
        }
      }

      // Audit log
      if (config.auditLog) {
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          params: redactParams(event.params ?? {}),
          allowed: result.allowed || config.enforcement === "warn",
          enforcement: config.enforcement,
          evaluations: result.evaluations.map((e) => ({
            allowed: e.allowed,
            reason: e.reason,
            component: e.component,
            rule: e.rule,
          })),
        });
      }

      // Block if denied and enforcement is "block"
      if (!result.allowed && config.enforcement === "block") {
        const denied = result.evaluations.filter((e) => !e.allowed);
        const reasons = denied.map((e) => `• ${e.reason}`).join("\n");
        return {
          block: true,
          blockReason: `🔒 Execution Isolation blocked this tool call:\n${reasons}\n\nIf this is intentional, adjust the isolation policy or ask the user to confirm.`,
        };
      }

      // ── Subprocess isolation: wrap exec commands with OS-level restrictions ──
      if (isExecTool(event.toolName) && event.params?.command) {
        const originalCommand = String(event.params.command);
        const { wrappedCommand, restrictions } = wrapCommand(originalCommand, policy);
        if (restrictions.length > 0) {
          logger.info(
            `[Execution Isolation] Wrapping command with restrictions: ${restrictions.join(", ")}`,
          );
          return { params: { ...event.params, command: wrappedCommand } };
        }
      }
    });

    // ── after_tool_call: audit completed calls ───────────────
    api.on("after_tool_call", (event) => {
      if (!config.auditLog) return;

      writeAuditEntry({
        timestamp: new Date().toISOString(),
        toolName: event.toolName,
        params: redactParams(event.params ?? {}),
        allowed: true,
        enforcement: config.enforcement,
        evaluations: [],
        durationMs: event.durationMs,
        error: event.error,
      });
    });
  },
};

export default plugin;
