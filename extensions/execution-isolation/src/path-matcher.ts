import { homedir } from "node:os";
import { normalize, resolve, isAbsolute } from "node:path";
import type { FilesystemPolicy, PolicyEvaluation } from "./policy-types.js";

const home = homedir();

/** Expand ~ to the user's home directory and normalize the path. */
export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    p = home + p.slice(1);
  }
  return normalize(resolve(p));
}

/** Check whether `target` is inside `prefix` (both already expanded). */
function isUnder(target: string, prefix: string): boolean {
  const norm = prefix.endsWith("/") ? prefix : prefix + "/";
  return target === prefix || target.startsWith(norm);
}

/**
 * Evaluate a file path against a filesystem policy.
 *
 * Deny rules always take precedence.
 * `operation` selects which allow list to check (`readAllow` or `writeAllow`).
 * If no allow list is defined for the operation, the path is allowed by default
 * (the caller's `defaultAction` determines fallback).
 */
export function matchesPathPolicy(
  filePath: string,
  policy: FilesystemPolicy,
  operation: "read" | "write",
  defaultAction: "allow" | "deny",
): PolicyEvaluation {
  const target = expandPath(filePath);

  // Deny list takes precedence
  if (policy.deny) {
    for (const pattern of policy.deny) {
      const expanded = expandPath(pattern);
      if (isUnder(target, expanded)) {
        return {
          allowed: false,
          reason: `Path '${filePath}' is in denied list (matches '${pattern}')`,
          rule: pattern,
          component: "filesystem",
        };
      }
    }
  }

  // Check the appropriate allow list
  const allowList = operation === "write" ? policy.writeAllow : policy.readAllow;
  if (allowList && allowList.length > 0) {
    for (const pattern of allowList) {
      const expanded = expandPath(pattern);
      if (isUnder(target, expanded)) {
        return {
          allowed: true,
          reason: `Path '${filePath}' matches ${operation} allow rule '${pattern}'`,
          rule: pattern,
          component: "filesystem",
        };
      }
    }
    // Has an allow list but didn't match
    return {
      allowed: false,
      reason: `Path '${filePath}' not in ${operation} allow list`,
      component: "filesystem",
    };
  }

  // No allow list for this operation — fall through to default
  return {
    allowed: defaultAction === "allow",
    reason:
      defaultAction === "allow"
        ? `Path '${filePath}' allowed by default (no ${operation} allow list defined)`
        : `Path '${filePath}' denied by default (no ${operation} allow list defined)`,
    component: "default",
  };
}

/** Try to extract file paths from tool parameters. */
export function extractPaths(params: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const pathKeys = [
    "path",
    "file",
    "filePath",
    "file_path",
    "cwd",
    "directory",
    "dir",
    "target",
    "destination",
    "src",
    "dest",
  ];
  for (const key of pathKeys) {
    const val = params[key];
    if (
      typeof val === "string" &&
      val.length > 0 &&
      (isAbsolute(val) || val.startsWith("~") || val.startsWith("."))
    ) {
      paths.push(val);
    }
  }
  return paths;
}
