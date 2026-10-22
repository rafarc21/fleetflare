// Fix 4 mutant 2 (#1259 round 3): `fileTask`/`adoptTask` both wrap the
// Worker's own `wake` field in `resolveLocalWake(...)` before printing it
// (cli/ff.ts lines ~284/~321) — the CLI-side swap that turns a `{local:true}`
// refusal into the real Orca terminal send, same as `fleet task message`'s
// own swap (test/bun/cli.task-message.test.ts). Removing EITHER
// `resolveLocalWake(...)` call (reverting to the raw Worker-reported line)
// survived with no test catching it: this file is that test, one case per
// function.
//
// bun:test, not vitest: cli/ff.ts is Bun-only and never imported from the
// vitest suite (same precedent as ff-file-task-retry.test.ts's own header).
// `fileTask`/`adoptTask` are imported directly — `main()` is guarded by
// `import.meta.main`, so importing them runs none of it.
//
// `resolveLocalWake` -> `sendLocalWake` calls `defaultOrcaDeps()` INSIDE
// cli/ff.ts (not injectable), so this test drives it for real: a fake `orca`
// binary on an absolute path (Bun.which resolves an absolute path that names
// an executable file, same technique T1.1's own test already uses), and
// TERM_PROGRAM=Orca so `orcaPresent` reads true. `defaultOrcaDeps`'s registry
// is a REAL file at `~/.fleet/orca-workspaces.json` (its path is a top-level
// module constant, computed from the real `homedir()` at import time, not
// overridable per test) — harmless here: the only registry call on this path
// is a read-only `get` for a studio id ("o--pilot") this test invents, which
// returns undefined on a real machine and falls through to the (matched)
// worktree-list fallback below.
//
// #1259 round 7 fix 1: `findPinnedLeadTerminal`'s fallback now filters
// candidates by `agentIdentity === "claude"` (never `connected` alone,
// which says nothing about identity), refusing (null) on anything but
// EXACTLY one such candidate. The fake orca script below never sets
// `agentIdentity` on its one terminal, so the fallback now finds zero
// claude-identified candidates and resolves no terminal at all — the swap
// having RUN is still the thing proved (see each test's own comment for
// exactly how).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTask, adoptTask } from "../../cli/ff";
import type { Credentials } from "../../cli/fleet";

const creds: Credentials = { workerUrl: "https://board.example", accessClientId: "id", accessClientSecret: "secret" };

const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

/** A fake `orca` binary answering the two LIST calls `sendLocalWake`'s
 *  foreground check makes (a healthy attach terminal whose preview carries
 *  claude chrome) and `terminal send` with `{}` — the SAME fixture shape
 *  cli.task-message.test.ts's own fake orca script uses, one studio id. */
function fakeOrcaFor(studioId: string, worktreeDisplayName: string, worktreeId: string): string {
  const home = mktemp();
  const fakeOrca = join(home, "orca");
  writeFileSync(fakeOrca, [
    "#!/bin/sh",
    "case \"$1:$2\" in",
    "  worktree:list)",
    `    echo '{"ok":true,"result":{"worktrees":[{"id":"${worktreeId}","displayName":"${worktreeDisplayName}","path":"/fake/orca/${worktreeDisplayName}"}]}}'`,
    "    ;;",
    "  terminal:list)",
    `    echo '{"ok":true,"result":{"terminals":[{"handle":"term_0","title":"fleet","connected":true,"worktreeId":"${worktreeId}","preview":"❯ ready"}]}}'`,
    "    ;;",
    "  *)",
    "    echo '{}'",
    "    ;;",
    "esac",
  ].join("\n"));
  chmodSync(fakeOrca, 0o755);
  return fakeOrca;
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "ff-local-wake-swap-"));
}

function captureStderr(): string[] {
  const lines: string[] = [];
  console.error = (line: string) => lines.push(line);
  return lines;
}

describe("fileTask swaps a local-refusal wake for the real Orca send, never the raw Worker line (#1259 fix 4.2)", () => {
  test("the final printed wake line reflects the terminal send, not the Worker's raw local-refusal wording", async () => {
    const studioId = "acme--pilot";
    const worktreeId = "repo-acme::/w/studio-acme-pilot";
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_CLI_COMMAND = fakeOrcaFor(studioId, "studio-acme--pilot", worktreeId);

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      number: 42,
      url: "https://github.com/o/r/issues/42",
      assignee: studioId,
      wake: {
        woke: false,
        local: true,
        digest: "WAKE TASK #42 \"do the thing\" | read: fleet task show 42",
        reason: `${studioId} is a local studio — no container to wake. Wake its lead by Orca terminal send from the operator's machine.`,
      },
    })) as typeof fetch;

    const lines = captureStderr();
    const number = await fileTask(creds, "o/r", studioId, "do the thing", [1], async () => {});

    expect(number).toBe(42);
    const wakeLine = lines.find((l) => l.includes("woke the studio") || l.includes("NO WAKE"));
    expect(wakeLine).toBeDefined();
    // #1259 round 7 fix 1: the fake orca script's terminal never carries
    // `agentIdentity: "claude"`, so `findPinnedLeadTerminal`'s fallback finds
    // zero claude-identified candidates and resolves no terminal at all —
    // but the SWAP STILL RAN: the printed line is `sendLocalWake`'s own
    // CLI-side refusal wording, never the Worker's raw "no container to
    // wake" text unchanged (which is what a passthrough, with
    // `resolveLocalWake`'s call removed, would still print verbatim).
    expect(wakeLine).toContain("no healthy Orca attach terminal");
    expect(wakeLine).not.toContain("no container to wake");
  });
});

describe("adoptTask swaps a local-refusal wake for the real Orca send, never the raw Worker line (#1259 fix 4.2)", () => {
  test("the final printed wake line reflects the terminal send, not the Worker's raw local-refusal wording", async () => {
    const studioId = "acme--release";
    const worktreeId = "repo-acme::/w/studio-acme-release";
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_CLI_COMMAND = fakeOrcaFor(studioId, "studio-acme--release", worktreeId);

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      number: 43,
      url: "https://github.com/o/r/issues/43",
      title: "fix the thing",
      state: "assigned",
      assignee: studioId,
      wake: {
        woke: false,
        local: true,
        digest: "WAKE TASK #43 \"fix the thing\" | read: fleet task show 43",
        reason: `${studioId} is a local studio — no container to wake. Wake its lead by Orca terminal send from the operator's machine.`,
      },
    })) as typeof fetch;

    const lines = captureStderr();
    const number = await adoptTask(creds, "o/r", studioId, 43);

    expect(number).toBe(43);
    const wakeLine = lines.find((l) => l.includes("woke the studio") || l.includes("NO WAKE"));
    expect(wakeLine).toBeDefined();
    // See the `fileTask` test above for why the fallback resolves no
    // terminal at all — the assertion below still proves the swap ran, not
    // the raw Worker refusal passed through unchanged.
    expect(wakeLine).toContain("no healthy Orca attach terminal");
    expect(wakeLine).not.toContain("no container to wake");
  });
});
