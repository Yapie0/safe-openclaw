import * as fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeAuditEntry, type IsolationAuditEntry } from "./audit.js";

vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("writeAuditEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a JSON line to the audit file", () => {
    const entry: IsolationAuditEntry = {
      timestamp: "2026-03-14T12:00:00.000Z",
      toolName: "shell",
      params: '{"command":"git status"}',
      allowed: true,
      enforcement: "block",
      evaluations: [],
    };

    writeAuditEntry(entry);

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining("isolation-audit.jsonl"),
      expect.stringContaining('"toolName":"shell"'),
    );
  });

  it("includes evaluation details", () => {
    const entry: IsolationAuditEntry = {
      timestamp: "2026-03-14T12:00:00.000Z",
      toolName: "read_file",
      params: '{"path":"~/.ssh/id_rsa"}',
      allowed: false,
      enforcement: "block",
      evaluations: [
        {
          allowed: false,
          reason: "Path denied",
          component: "filesystem",
          rule: "~/.ssh",
        },
      ],
    };

    writeAuditEntry(entry);

    const written = (fs.appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.allowed).toBe(false);
    expect(parsed.evaluations).toHaveLength(1);
    expect(parsed.evaluations[0].component).toBe("filesystem");
  });

  it("does not throw when fs operations fail", () => {
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => {
      writeAuditEntry({
        timestamp: "2026-03-14T12:00:00.000Z",
        toolName: "test",
        params: "{}",
        allowed: true,
        enforcement: "block",
        evaluations: [],
      });
    }).not.toThrow();
  });
});
