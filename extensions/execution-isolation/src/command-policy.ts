import { basename } from "node:path";
import type { CommandPolicy, PolicyEvaluation } from "./policy-types.js";

/** Extract the base command name from a full path or shell invocation. */
export function extractCommandName(command: string): string {
  const trimmed = command.trim();

  // Handle shell wrappers: sh -c "actual_cmd ...", bash -c "..."
  const shellMatch = trimmed.match(/^(?:\/[\w/]*\/)?(sh|bash|zsh)\s+-c\s+["']?(\S+)/);
  if (shellMatch) {
    return basename(shellMatch[2]);
  }

  // Handle env prefix: env VAR=val cmd
  const envMatch = trimmed.match(/^(?:\/[\w/]*\/)?env\s+(?:\w+=\S+\s+)*(\S+)/);
  if (envMatch) {
    return basename(envMatch[1]);
  }

  // Take the first token and strip the path
  const firstToken = trimmed.split(/\s+/)[0];
  return basename(firstToken);
}

/**
 * Evaluate a command against the command policy.
 * Deny list always takes precedence.
 */
export function matchesCommandPolicy(
  command: string,
  policy: CommandPolicy,
  defaultAction: "allow" | "deny",
): PolicyEvaluation {
  const cmdName = extractCommandName(command);

  // Deny list takes precedence
  if (policy.deny) {
    for (const denied of policy.deny) {
      if (cmdName === denied || command.includes(denied)) {
        return {
          allowed: false,
          reason: `Command '${cmdName}' is in denied list (matches '${denied}')`,
          rule: denied,
          component: "command",
        };
      }
    }
  }

  // Check allow list
  if (policy.allow && policy.allow.length > 0) {
    for (const allowed of policy.allow) {
      if (cmdName === allowed) {
        return {
          allowed: true,
          reason: `Command '${cmdName}' is in allow list`,
          rule: allowed,
          component: "command",
        };
      }
    }
    // Has an allow list but didn't match
    return {
      allowed: false,
      reason: `Command '${cmdName}' not in allow list`,
      component: "command",
    };
  }

  return {
    allowed: defaultAction === "allow",
    reason:
      defaultAction === "allow"
        ? `Command '${cmdName}' allowed by default`
        : `Command '${cmdName}' denied by default`,
    component: "default",
  };
}

/** Try to extract commands from tool parameters. */
export function extractCommands(params: Record<string, unknown>): string[] {
  const commands: string[] = [];
  const cmdKeys = ["command", "cmd", "script", "exec", "argv"];
  for (const key of cmdKeys) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0) {
      commands.push(val);
    }
  }
  return commands;
}
