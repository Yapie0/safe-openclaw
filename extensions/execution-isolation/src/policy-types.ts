/** Top-level isolation policy configuration. */
export type IsolationPolicy = {
  /** Default action when no rule matches. */
  defaultAction: "allow" | "deny";
  /** Filesystem access rules. */
  filesystem?: FilesystemPolicy;
  /** Network access rules. */
  network?: NetworkPolicy;
  /** Command execution rules. */
  commands?: CommandPolicy;
  /** Resource limits for spawned processes. */
  resources?: ResourceLimits;
  /** Per-tool overrides keyed by tool name. */
  toolOverrides?: Record<string, Partial<IsolationPolicy>>;
};

export type FilesystemPolicy = {
  /** Paths allowed for read access (glob-like prefixes). */
  readAllow?: string[];
  /** Paths allowed for write access (glob-like prefixes). */
  writeAllow?: string[];
  /** Paths explicitly denied (takes precedence over allow). */
  deny?: string[];
};

export type NetworkPolicy = {
  /** Allowed domains/IPs. */
  allow?: string[];
  /** Denied domains/IPs (takes precedence over allow). */
  deny?: string[];
  /** Allow all outbound (default: false in deny-default mode). */
  allowAll?: boolean;
};

export type CommandPolicy = {
  /** Allowed command binaries (e.g. ["git", "node", "pnpm"]). */
  allow?: string[];
  /** Denied command binaries (takes precedence). */
  deny?: string[];
};

export type ResourceLimits = {
  /** Max execution time in ms. */
  timeoutMs?: number;
  /** Max stdout+stderr size in bytes. */
  maxOutputBytes?: number;
};

export type PolicyEvaluation = {
  allowed: boolean;
  reason: string;
  rule?: string;
  /** Which policy component triggered the decision. */
  component: "filesystem" | "network" | "command" | "resource" | "default";
};
