// Board #220: `fleet attach <id> --print-handle` — a purely local, read-only
// Orca query. `cmdPrintAttachHandle` (cli/fleet.ts) is its own function,
// dispatched from `main()` BEFORE `loadCredentials()` and never through
// `cmdAttach`'s interactive WebSocket-attach machinery (see cli/fleet.ts's
// own doc comment on `cmdPrintAttachHandle`). cli/fleet.ts is never imported
// from vitest (bun-only globals — Bun.file et al.); same bun:test lane as
// test/bun/orca-workspace.test.ts, whose fake-OrcaDeps idiom this file's own
// `fake()` below matches. Orca FAKES ONLY — no real `orca` call anywhere
// here, no real tmux, no real WebSocket.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPrintAttachHandle } from "../../cli/fleet";
import type { OrcaDeps, OrcaResult } from "../../cli/orca-workspace";

const ORCA_ENV = { TERM_PROGRAM: "Orca" } as Record<string, string | undefined>;

function ok(stdout: string): OrcaResult {
  return { ok: true, stdout, stderr: "", timedOut: false };
}

function fake(answers: Record<string, OrcaResult>): { deps: OrcaDeps; calls: string[][] } {
  const calls: string[][] = [];
  const memory = new Map<string, string>();
  const deps: OrcaDeps = {
    env: ORCA_ENV,
    hasBinary: () => "orca",
    registry: { get: (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); } },
    log: () => {},
    run: async (args) => {
      calls.push(args);
      return answers[`${args[0]} ${args[1]}`] ?? ok("{}");
    },
    lock: (_id, fn) => fn(),
  };
  return { deps, calls };
}

function worktrees(...displayNames: string[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: {
      worktrees: displayNames.map((displayName) => ({
        id: `repo-websites::/w/${displayName}`, displayName, path: `/fake/orca/${displayName}`,
      })),
    },
  }));
}

function terminalEntries(...entries: Record<string, unknown>[]): OrcaResult {
  return ok(JSON.stringify({ ok: true, result: { terminals: entries } }));
}

/** Captures `console.log`'s arguments, always restoring the real one — even
 *  if `fn` throws. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

describe("cmdPrintAttachHandle — board #220", () => {
  test("prints the healthy attach terminal's handle, and makes only LIST calls (no create/close/rename)", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({
        handle: "term_handle", title: "fleet", connected: true,
        worktreeId: "repo-websites::/w/studio-websites--maestro",
      }),
    });
    const { lines } = await captureLog(() => cmdPrintAttachHandle("websites--maestro", f.deps));
    expect(lines).toEqual(["term_handle"]);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((c) => c[1] === "list")).toBe(true);
  });

  test("prints 'none' when the studio has no worktree at all", async () => {
    const f = fake({
      "worktree list": worktrees("staging"), // no row for websites--maestro
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [] } })),
    });
    const { lines } = await captureLog(() => cmdPrintAttachHandle("websites--maestro", f.deps));
    expect(lines).toEqual(["none"]);
  });

  test("prints 'none' outside Orca, and makes no orca call", async () => {
    const f = fake({});
    f.deps.env = { TERM_PROGRAM: "Apple_Terminal" };
    const { lines } = await captureLog(() => cmdPrintAttachHandle("websites--maestro", f.deps));
    expect(lines).toEqual(["none"]);
    expect(f.calls).toEqual([]);
  });
});

// Source-pinning, same technique test/bun/cli-destroy-flags.test.ts already
// uses for a call-site guarantee plain behavior tests can't make: proving
// what a function's body does NOT contain, and where one branch sits
// relative to another in main()'s own dispatcher.
describe("cmdPrintAttachHandle never touches cmdAttach's interactive machinery", () => {
  const src = readFileSync(join(import.meta.dir, "../../cli/fleet.ts"), "utf8");

  function body(sig: string): string {
    const start = src.indexOf(sig);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n}\n", start));
  }

  test("cmdPrintAttachHandle's own body never sets raw mode, touches stdin, or opens a WebSocket", () => {
    const fn = body("export async function cmdPrintAttachHandle(");
    expect(fn).not.toContain("process.stdin");
    expect(fn).not.toContain("setRawMode");
    expect(fn).not.toContain("WebSocket");
  });

  test("main() branches to cmdPrintAttachHandle BEFORE loadCredentials — no Worker call reachable first", () => {
    const printHandleBranch = src.indexOf('parsed.cmd === "attach" && parsed.printHandle');
    const loadCreds = src.indexOf("const creds = await loadCredentials();");
    expect(printHandleBranch).toBeGreaterThan(-1);
    expect(loadCreds).toBeGreaterThan(-1);
    expect(printHandleBranch).toBeLessThan(loadCreds);
  });
});
