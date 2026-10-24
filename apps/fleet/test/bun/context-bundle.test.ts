import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { contextBundleCmd, contextReadCmd, contextCleanCmd, CONTEXT_EMPTY, CONTEXT_TAR_PATH } from "../../src/studio/rescue";
import { contextBundleKey } from "../../src/studio/archive";

// Issue #1282 — the .context/ bundle command, run as real shell against a temp
// checkout. Mirrors session-tar-budget.test.ts's "run the REAL command" lane:
// the command is what the Worker ships via sbExec, so it is exercised here
// with a real `.context/` dir, not a re-typed copy of the tar logic.

function checkout(repo: string, contextFiles: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "fleet-context-"));
  const dir = join(base, repo);
  mkdirSync(join(dir, ".context"), { recursive: true });
  for (const [rel, content] of Object.entries(contextFiles)) {
    const p = join(dir, ".context", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe("contextBundleCmd (#1282)", () => {
  test("an absent or empty .context prints CONTEXT_EMPTY and stages nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-context-empty-"));
    const dir = join(base, "fleetflare");
    mkdirSync(dir, { recursive: true }); // checkout, no .context
    const res = runSnippet({ script: contextBundleCmd("fleetflare", base), sourced: true, shell: "sh" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(CONTEXT_EMPTY);
    expect(existsSync(CONTEXT_TAR_PATH)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  test("a populated .context tars to the staging path and prints its size", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-context-pop-"));
    const dir = join(base, "fleetflare");
    mkdirSync(join(dir, ".context", "notes"), { recursive: true });
    writeFileSync(join(dir, ".context", "INBOX.md"), "operator note\n");
    writeFileSync(join(dir, ".context", "notes", "shot.md"), "screenshot note\n");

    const res = runSnippet({ script: contextBundleCmd("fleetflare", base), sourced: true, shell: "sh" });
    expect(res.code).toBe(0);
    const size = Number.parseInt(res.stdout.trim(), 10);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
    // The staged tar is gzip and non-empty.
    expect(existsSync(CONTEXT_TAR_PATH)).toBe(true);

    // The read-back command emits base64 that decodes to the same size.
    const read = runSnippet({ script: contextReadCmd(), sourced: true, shell: "sh" });
    expect(read.code).toBe(0);
    const decoded = Buffer.from(read.stdout.replace(/\s+/g, ""), "base64");
    expect(decoded.length).toBe(size);

    // Clean removes the staging file.
    const clean = runSnippet({ script: contextCleanCmd(), sourced: true, shell: "sh" });
    expect(clean.code).toBe(0);
    expect(existsSync(CONTEXT_TAR_PATH)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  test("the tar members are checkout-relative, so a restore untars back into the same layout", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-context-rel-"));
    const dir = join(base, "fleetflare");
    mkdirSync(join(dir, ".context"), { recursive: true });
    writeFileSync(join(dir, ".context", "INBOX.md"), "note\n");

    runSnippet({ script: contextBundleCmd("fleetflare", base), sourced: true, shell: "sh" });
    // Untar into a fresh dir and confirm the member is `.context/INBOX.md`.
    const out = mkdtempSync(join(tmpdir(), "fleet-context-out-"));
    const untar = runSnippet({
      script: `mkdir -p ${out} && tar -xzf ${CONTEXT_TAR_PATH} -C ${out} && cat ${out}/.context/INBOX.md`,
      sourced: true, shell: "sh",
    });
    expect(untar.code).toBe(0);
    expect(untar.stdout.trim()).toBe("note");
    runSnippet({ script: contextCleanCmd(), sourced: true, shell: "sh" });
    rmSync(base, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  test("contextBundleKey is the fixed R2 key the ship side puts to and the restore side gets from", () => {
    expect(contextBundleKey("fleetflare--pilot")).toBe("sessions/fleetflare--pilot/context.tar.gz");
  });
});