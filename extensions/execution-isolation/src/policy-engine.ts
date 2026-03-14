import {
  BUILTIN_COMMANDS_ALLOW,
  BUILTIN_COMMANDS_DENY,
  BUILTIN_NETWORK_ALLOW,
} from "./builtin-allowlist.js";
import { matchesCommandPolicy, extractCommands } from "./command-policy.js";
import { matchesNetworkPolicy, extractUrls } from "./network-policy.js";
import { matchesPathPolicy, extractPaths } from "./path-matcher.js";
import type { IsolationPolicy, PolicyEvaluation } from "./policy-types.js";

export type EngineResult = {
  allowed: boolean;
  evaluations: PolicyEvaluation[];
};

/**
 * Evaluate a tool call against the full isolation policy.
 * Returns the combined result; if any sub-evaluation denies, the call is denied.
 */
export function evaluateToolCall(
  toolName: string,
  params: Record<string, unknown>,
  policy: IsolationPolicy,
): EngineResult {
  // Merge built-in allowlists and tool-specific overrides
  const effective = applyBuiltinAllowlists(mergeToolOverrides(policy, toolName));
  const defaultAction = effective.defaultAction;
  const evaluations: PolicyEvaluation[] = [];

  // ── Filesystem checks ──
  if (effective.filesystem) {
    const paths = extractPaths(params);
    for (const p of paths) {
      // Determine operation from tool name heuristics
      const op = isWriteOperation(toolName, params) ? "write" : "read";
      const result = matchesPathPolicy(p, effective.filesystem, op, defaultAction);
      evaluations.push(result);
    }
  }

  // ── Command checks ──
  if (effective.commands) {
    const commands = extractCommands(params);
    for (const cmd of commands) {
      const result = matchesCommandPolicy(cmd, effective.commands, defaultAction);
      evaluations.push(result);
    }
  }

  // ── Network checks ──
  if (effective.network) {
    const urls = extractUrls(params);
    for (const url of urls) {
      const result = matchesNetworkPolicy(url, effective.network, defaultAction);
      evaluations.push(result);
    }
  }

  // If no evaluations were generated, allow/deny based on default
  if (evaluations.length === 0) {
    return { allowed: true, evaluations: [] };
  }

  // Any denial means the entire call is denied
  const denied = evaluations.filter((e) => !e.allowed);
  return {
    allowed: denied.length === 0,
    evaluations,
  };
}

/** Merge tool-specific overrides into the base policy. */
function mergeToolOverrides(policy: IsolationPolicy, toolName: string): IsolationPolicy {
  const override = policy.toolOverrides?.[toolName];
  if (!override) return policy;
  return {
    ...policy,
    ...override,
    filesystem: override.filesystem ?? policy.filesystem,
    network: override.network ?? policy.network,
    commands: override.commands ?? policy.commands,
    resources: override.resources ?? policy.resources,
  };
}

/**
 * Merge built-in trusted allowlists into the policy.
 * User deny rules still take precedence over built-in allows.
 */
function applyBuiltinAllowlists(policy: IsolationPolicy): IsolationPolicy {
  return {
    ...policy,
    network: policy.network
      ? {
          ...policy.network,
          allow: dedup([...BUILTIN_NETWORK_ALLOW, ...(policy.network.allow ?? [])]),
        }
      : { allow: BUILTIN_NETWORK_ALLOW },
    commands: policy.commands
      ? {
          ...policy.commands,
          allow: dedup([...BUILTIN_COMMANDS_ALLOW, ...(policy.commands.allow ?? [])]),
          deny: dedup([...BUILTIN_COMMANDS_DENY, ...(policy.commands.deny ?? [])]),
        }
      : { allow: BUILTIN_COMMANDS_ALLOW, deny: BUILTIN_COMMANDS_DENY },
  };
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** Heuristic: is this tool call likely a write operation? */
function isWriteOperation(toolName: string, params: Record<string, unknown>): boolean {
  const writeTools = [
    "write_file",
    "edit_file",
    "create_file",
    "save",
    "write",
    "patch",
    "move",
    "rename",
    "delete",
    "rm",
    "mkdir",
  ];
  const lower = toolName.toLowerCase();
  for (const wt of writeTools) {
    if (lower.includes(wt)) return true;
  }
  // Check for write-like params
  if (typeof params.content === "string" || typeof params.data === "string") return true;
  return false;
}
