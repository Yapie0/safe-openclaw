import type { NetworkPolicy, PolicyEvaluation } from "./policy-types.js";

/** Extract domain from a URL string. */
export function extractDomain(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.hostname.toLowerCase();
  } catch {
    // Might be just a domain
    const domainMatch = urlStr.match(/^(?:https?:\/\/)?([^/:]+)/i);
    return domainMatch ? domainMatch[1].toLowerCase() : null;
  }
}

/** Check if a domain matches a pattern (supports wildcard prefix like *.github.com). */
function domainMatches(domain: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".github.com"
    return domain === p.slice(2) || domain.endsWith(suffix);
  }
  return domain === p;
}

/**
 * Evaluate a URL/domain against the network policy.
 * Deny list always takes precedence.
 */
export function matchesNetworkPolicy(
  urlOrDomain: string,
  policy: NetworkPolicy,
  defaultAction: "allow" | "deny",
): PolicyEvaluation {
  if (policy.allowAll) {
    return {
      allowed: true,
      reason: "All network access allowed (allowAll=true)",
      component: "network",
    };
  }

  const domain = extractDomain(urlOrDomain);
  if (!domain) {
    return {
      allowed: defaultAction === "allow",
      reason: `Could not extract domain from '${urlOrDomain}'`,
      component: "network",
    };
  }

  // Deny list takes precedence
  if (policy.deny) {
    for (const pattern of policy.deny) {
      if (domainMatches(domain, pattern)) {
        return {
          allowed: false,
          reason: `Domain '${domain}' is in denied list (matches '${pattern}')`,
          rule: pattern,
          component: "network",
        };
      }
    }
  }

  // Check allow list
  if (policy.allow && policy.allow.length > 0) {
    for (const pattern of policy.allow) {
      if (domainMatches(domain, pattern)) {
        return {
          allowed: true,
          reason: `Domain '${domain}' is in allow list (matches '${pattern}')`,
          rule: pattern,
          component: "network",
        };
      }
    }
    return {
      allowed: false,
      reason: `Domain '${domain}' not in allow list`,
      component: "network",
    };
  }

  return {
    allowed: defaultAction === "allow",
    reason:
      defaultAction === "allow"
        ? `Domain '${domain}' allowed by default`
        : `Domain '${domain}' denied by default`,
    component: "default",
  };
}

/** Try to extract URLs from tool parameters. */
export function extractUrls(params: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const urlKeys = ["url", "targetUrl", "href", "endpoint", "uri", "baseUrl"];
  for (const key of urlKeys) {
    const val = params[key];
    if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))) {
      urls.push(val);
    }
  }
  return urls;
}
