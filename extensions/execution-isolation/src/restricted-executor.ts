/**
 * Restricted Executor — wraps commands with OS-level isolation.
 *
 * This module generates a wrapper command that applies resource limits
 * and sandboxing before executing the original command.
 *
 * - macOS: sandbox-exec profiles (filesystem/network restrictions)
 * - Linux: unshare namespaces + seccomp (when available)
 * - All platforms: ulimit resource limits + timeout
 */
import { platform } from "node:os";
import type { IsolationPolicy, ResourceLimits } from "./policy-types.js";

export type WrapResult = {
  /** The wrapped command string to execute instead of the original. */
  wrappedCommand: string;
  /** Human-readable description of applied restrictions. */
  restrictions: string[];
};

/**
 * Wrap a command with OS-level restrictions based on the policy.
 * Returns the wrapped command string and a list of applied restrictions.
 */
export function wrapCommand(originalCommand: string, policy: IsolationPolicy): WrapResult {
  const os = platform();
  if (os === "darwin") {
    return wrapDarwin(originalCommand, policy);
  }
  if (os === "linux") {
    return wrapLinux(originalCommand, policy);
  }
  // Fallback for other platforms — basic resource limits only
  return wrapFallback(originalCommand, policy);
}

// ── macOS: sandbox-exec ─────────────────────────────────────

function wrapDarwin(command: string, policy: IsolationPolicy): WrapResult {
  const restrictions: string[] = [];
  const profile = generateSandboxProfile(policy);

  if (profile) {
    restrictions.push("sandbox-exec filesystem/network restrictions");
    const escaped = escapeForShell(command);
    const profileEscaped = escapeForShell(profile);
    let wrapped = `sandbox-exec -p ${profileEscaped} /bin/bash -c ${escaped}`;
    wrapped = applyResourceLimits(wrapped, policy.resources, restrictions);
    return { wrappedCommand: wrapped, restrictions };
  }

  // No sandbox profile needed, just resource limits
  return wrapFallback(command, policy);
}

/**
 * Generate a macOS sandbox-exec profile from the isolation policy.
 * Returns null if no restrictions would be applied.
 */
export function generateSandboxProfile(policy: IsolationPolicy): string | null {
  const rules: string[] = [];
  let hasRestriction = false;

  // Start with deny-all or allow-all based on default
  if (policy.defaultAction === "deny") {
    rules.push("(version 1)");
    rules.push("(deny default)");
    // Always allow basic operations needed for any command
    rules.push("(allow process-exec)");
    rules.push("(allow process-fork)");
    rules.push("(allow sysctl-read)");
    rules.push("(allow mach-lookup)");
    hasRestriction = true;
  } else {
    rules.push("(version 1)");
    rules.push("(allow default)");
  }

  // Filesystem deny rules
  if (policy.filesystem?.deny) {
    for (const p of policy.filesystem.deny) {
      const expanded = p.replace(/^~/, process.env.HOME ?? "/tmp");
      rules.push(`(deny file-read* (subpath "${expanded}"))`);
      rules.push(`(deny file-write* (subpath "${expanded}"))`);
      hasRestriction = true;
    }
  }

  // Filesystem allow rules (only meaningful in deny-default mode)
  if (policy.defaultAction === "deny") {
    const readPaths = policy.filesystem?.readAllow ?? [];
    const writePaths = policy.filesystem?.writeAllow ?? [];
    const allPaths = [...new Set([...readPaths, ...writePaths])];
    for (const p of allPaths) {
      const expanded = p.replace(/^~/, process.env.HOME ?? "/tmp");
      rules.push(`(allow file-read* (subpath "${expanded}"))`);
    }
    for (const p of writePaths) {
      const expanded = p.replace(/^~/, process.env.HOME ?? "/tmp");
      rules.push(`(allow file-write* (subpath "${expanded}"))`);
    }
    // Always allow reading system paths needed for execution
    rules.push('(allow file-read* (subpath "/usr"))');
    rules.push('(allow file-read* (subpath "/bin"))');
    rules.push('(allow file-read* (subpath "/sbin"))');
    rules.push('(allow file-read* (subpath "/Library"))');
    rules.push('(allow file-read* (subpath "/System"))');
    rules.push('(allow file-read* (subpath "/private/tmp"))');
    rules.push('(allow file-read* (subpath "/dev"))');
    rules.push('(allow file-write* (subpath "/dev"))');
    rules.push('(allow file-read* (subpath "/private/var"))');
    rules.push('(allow file-read* (subpath "/var"))');
    rules.push('(allow file-read* (subpath "/tmp"))');
    rules.push('(allow file-write* (subpath "/tmp"))');
    rules.push('(allow file-write* (subpath "/private/tmp"))');
  }

  // Network deny rules
  if (policy.network && !policy.network.allowAll) {
    if (policy.network.deny && policy.network.deny.length > 0) {
      // In allow-default mode, we can only deny specific things
      // sandbox-exec doesn't support domain-based filtering easily,
      // so we deny all network if there's a deny list and no allow list
      if (policy.defaultAction === "deny") {
        rules.push("(deny network*)");
        rules.push("(allow network* (local udp))"); // Allow DNS
        rules.push("(allow network* (local tcp))"); // Allow localhost
        hasRestriction = true;
      }
    }
    if (policy.defaultAction === "deny" && !policy.network.allow) {
      rules.push("(deny network*)");
      rules.push("(allow network* (local udp))");
      rules.push("(allow network* (local tcp))");
      hasRestriction = true;
    }
  }

  if (!hasRestriction) return null;
  return rules.join("\n");
}

// ── Linux: unshare + resource limits ────────────────────────

function wrapLinux(command: string, policy: IsolationPolicy): WrapResult {
  const restrictions: string[] = [];
  const parts: string[] = [];

  // Use unshare for namespace isolation if filesystem deny rules exist
  if (policy.filesystem?.deny && policy.filesystem.deny.length > 0) {
    // Mount namespace: make denied paths inaccessible
    const mountCmds = policy.filesystem.deny.map((p) => {
      const expanded = p.replace(/^~/, process.env.HOME ?? "/tmp");
      return `mount --bind /dev/null '${expanded}' 2>/dev/null;`;
    });
    const escaped = escapeForShell(command);
    const inner = `${mountCmds.join(" ")} exec /bin/bash -c ${escaped}`;
    parts.push(`unshare --mount --fork /bin/bash -c ${escapeForShell(inner)}`);
    restrictions.push("mount namespace isolation (denied paths hidden)");
  } else {
    parts.push(command);
  }

  let wrapped = parts.join(" ");
  wrapped = applyResourceLimits(wrapped, policy.resources, restrictions);
  return { wrappedCommand: wrapped, restrictions };
}

// ── Fallback: resource limits only ──────────────────────────

function wrapFallback(command: string, policy: IsolationPolicy): WrapResult {
  const restrictions: string[] = [];
  const wrapped = applyResourceLimits(command, policy.resources, restrictions);
  if (restrictions.length === 0) {
    return { wrappedCommand: command, restrictions: [] };
  }
  return { wrappedCommand: wrapped, restrictions };
}

// ── Resource limits (cross-platform) ────────────────────────

function applyResourceLimits(
  command: string,
  resources: ResourceLimits | undefined,
  restrictions: string[],
): string {
  if (!resources) return command;

  const ulimits: string[] = [];

  // Timeout via the `timeout` command
  if (resources.timeoutMs && resources.timeoutMs > 0) {
    const secs = Math.ceil(resources.timeoutMs / 1000);
    const escaped = escapeForShell(command);
    command = `timeout ${secs} /bin/bash -c ${escaped}`;
    restrictions.push(`timeout: ${secs}s`);
  }

  // Max output size (file size limit)
  if (resources.maxOutputBytes && resources.maxOutputBytes > 0) {
    const blocks = Math.ceil(resources.maxOutputBytes / 512);
    ulimits.push(`ulimit -f ${blocks}`);
    restrictions.push(`max file size: ${resources.maxOutputBytes} bytes`);
  }

  if (ulimits.length > 0) {
    const escaped = escapeForShell(command);
    command = `/bin/bash -c ${escapeForShell(ulimits.join("; ") + "; exec /bin/bash -c " + escaped)}`;
  }

  return command;
}

// ── Utilities ───────────────────────────────────────────────

/** Escape a string for safe inclusion in a single-quoted shell argument. */
function escapeForShell(s: string): string {
  // Use $'...' syntax to handle all special characters
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
