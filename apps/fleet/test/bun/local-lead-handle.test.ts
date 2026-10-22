// #1259 round 6: replaces test/bun/local-lead-liveness.test.ts entirely —
// that file proved round 5's tty+ps mechanism, which this round removes, not
// patches (see cli/orca-workspace.ts's own doc comments on
// `readLeadHandle`/`writeLeadHandle`/`isIdleClaudeTerminal` for why: terminal
// SELECTION was never tied to the verified tty, a stale tty could be
// reassigned to an unrelated process, and a pre-PR studio had no lead.tty at
// all). This file proves the REPLACEMENT mechanism's two independently
// verifiable pieces:
//
//  - `readLeadHandle`/`writeLeadHandle`: pure file I/O against a real temp
//    directory — no fake Orca needed, no real process needed either.
//  - `isIdleClaudeTerminal`: pure boolean logic over every combination of
//    `agentIdentity`/`agentWait`.
//
// HONEST LIMITATION (stated here, not just in the PR report): this file
// cannot and does not claim to verify that a REAL Orca installation's
// `terminal list --json` actually populates `agentIdentity`/`agentWait` the
// way the operator's own real-world measurement describes — there is no
// Orca in this sandbox to check that against. Trusted as this file's own
// "MEASURED" doc comments already are, same as every other such comment in
// cli/orca-workspace.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIdleClaudeTerminal, readLeadHandle, writeLeadHandle } from "../../cli/orca-workspace";

describe("readLeadHandle / writeLeadHandle — pure file I/O, round-tripped against a real temp dir", () => {
  test("no .fleet/lead.handle file at all reads null (a pre-#1259-round-6 studio, never pinned yet)", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-handle-absent-"));
    try {
      expect(readLeadHandle(worktreePath)).toBeNull();
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("an empty lead.handle file reads null, not an empty string", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-handle-empty-"));
    try {
      mkdirSync(join(worktreePath, ".fleet"), { recursive: true });
      writeFileSync(join(worktreePath, ".fleet", "lead.handle"), "\n");
      expect(readLeadHandle(worktreePath)).toBeNull();
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("writeLeadHandle then readLeadHandle round-trips the exact handle, trimmed of trailing whitespace", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-handle-roundtrip-"));
    try {
      writeLeadHandle(worktreePath, "term_abc123");
      expect(readLeadHandle(worktreePath)).toBe("term_abc123");
      // One line, a plain text file — the same convention round 5's
      // now-removed lead.tty used.
      expect(readFileSync(join(worktreePath, ".fleet", "lead.handle"), "utf8").trim()).toBe("term_abc123");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("writeLeadHandle creates .fleet/ itself when absent — a brand-new worktree has no .fleet/ yet at this exact call site", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-handle-mkdir-"));
    try {
      writeLeadHandle(worktreePath, "term_new");
      expect(readLeadHandle(worktreePath)).toBe("term_new");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("writeLeadHandle overwrites a stale handle with a fresh one — resume's own backfill/replace case", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-handle-overwrite-"));
    try {
      writeLeadHandle(worktreePath, "term_stale");
      writeLeadHandle(worktreePath, "term_fresh");
      expect(readLeadHandle(worktreePath)).toBe("term_fresh");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("writeLeadHandle never throws when the directory cannot be created (best-effort, never fails its caller)", () => {
    // A path nested under a file (not a directory) can never have children
    // created under it — mkdirSync throws ENOTDIR. writeLeadHandle must
    // swallow that, not propagate it: a failed write only costs the NEXT
    // call a fallback discovery, never THIS call's own result.
    const root = mkdtempSync(join(tmpdir(), "fleet-handle-notdir-"));
    const blockingFile = join(root, "blocker");
    writeFileSync(blockingFile, "x");
    try {
      expect(() => writeLeadHandle(blockingFile, "term_whatever")).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isIdleClaudeTerminal — Orca's own tracked agent state, every combination (#1259 round 6)", () => {
  test("agentIdentity 'claude' and agentWait undefined is idle", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "claude", agentWait: undefined })).toBe(true);
  });

  test("agentIdentity 'claude' and agentWait null is idle (the operator's own 'agentWait==null' wording matches both)", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "claude", agentWait: null })).toBe(true);
  });

  test("agentIdentity 'claude' and agentWait absent entirely (no field at all) is idle", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "claude" })).toBe(true);
  });

  test("agentIdentity 'claude' with a non-null agentWait (blocked on a prompt/modal) is NOT idle", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "claude", agentWait: "permission" })).toBe(false);
  });

  test("agentIdentity 'claude' with agentWait 0 (falsy but non-null) is still NOT idle — == null must not catch 0", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "claude", agentWait: 0 })).toBe(false);
  });

  test("agentIdentity some other value (not claude), agentWait null, is NOT idle", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: "zsh", agentWait: null })).toBe(false);
  });

  test("agentIdentity undefined entirely is NOT idle, however agentWait reads", () => {
    expect(isIdleClaudeTerminal({ agentWait: null })).toBe(false);
    expect(isIdleClaudeTerminal({})).toBe(false);
  });

  test("agentIdentity null (Orca explicitly reports no tracked agent) is NOT idle", () => {
    expect(isIdleClaudeTerminal({ agentIdentity: null, agentWait: null })).toBe(false);
  });
});
