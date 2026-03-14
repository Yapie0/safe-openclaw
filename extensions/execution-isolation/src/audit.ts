import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PolicyEvaluation } from "./policy-types.js";

export type IsolationAuditEntry = {
  timestamp: string;
  toolName: string;
  params: string;
  allowed: boolean;
  enforcement: "block" | "warn" | "off";
  evaluations: Array<{
    allowed: boolean;
    reason: string;
    component: string;
    rule?: string;
  }>;
  durationMs?: number;
  error?: string;
};

const AUDIT_FILE = join(homedir(), ".openclaw", "isolation-audit.jsonl");

export function writeAuditEntry(entry: IsolationAuditEntry): void {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — don't crash the plugin if audit write fails
  }
}
