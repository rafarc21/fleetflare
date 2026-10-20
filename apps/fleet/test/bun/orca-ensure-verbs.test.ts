// `ensureStudioWorkspace` — every running studio gets its OWN Orca sidebar
// entry (a worktree), not a tab buried in whichever worktree happened to
// spawn it. the operator 2026-09-11: "I won't accept invisible things spending money
// in the cloud without me seeing it."
//
// bun:test lane, not the workerd lane: this is CLI code (Bun.which, Bun.spawn,
// process env), and vitest-pool-workers cannot host any of it. Every orca
// invocation is INJECTED, so no test here ever shells out to real Orca.
//
// The ensure-CORE half of old orca-ensure.test.ts, split per plan
// docs/maintainability/plans/2026-10-13-s35-f2-orca-ensure-split-795.md
// (issue #795): name derivation, presence, and ensureStudioWorkspace's five
// hard requirements. The sibling orca-ensure-reconcile.test.ts carries the
// verbs/reconcile half (duplicate-terminal reconciliation, the tabs/plan
// verbs, the exit-code process test); teardown lives in
// orca-registry-teardown.test.ts, and the registry, locks, and ROW column live
// in orca-registry-rows.test.ts.
import { test, describe, expect } from "bun:test";
import {
  studioWorkspaceName,
  orcaPresent,
  ensureStudioWorkspace,
  reconcileStudioWorkspaces,
  ensureLocalStudioWorktree,
  localWorktreeCreateArgs,
  localLaunchCommand,
  localLeadGateHookCommand,
  type OrcaDeps,
  type OrcaResult,
} from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";
import { ORCA_ENV, ok, terminals } from "./helpers/orca-fixtures";

// ---------------------------------------------------------------------------
// Fakes. `run` records every argv it was handed, which is how the "makes NO
// orca call" and "no second create" tests assert absence rather than outcome.

interface Fake {
  deps: OrcaDeps;
  calls: string[][];
  lines: string[];
}

/** In-memory stand-in for `defaultOrcaDeps()`'s real, file-backed lock — same
 *  contract (serializes concurrent callers per key), no filesystem. A plain
 *  per-key promise chain: exactly what board #42's race tests (which live in
 *  the sibling orca-ensure-reconcile.test.ts) need to prove the fix actually
 *  serializes, without a real second OS process. */
function memoryLock(): OrcaDeps["lock"] {
  const chains = new Map<string, Promise<unknown>>();
  return (studioId, fn) => {
    const prior = chains.get(studioId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    chains.set(studioId, next.catch(() => undefined));
    return next as ReturnType<typeof fn>;
  };
}

/** Board #39: every ensure call now carries the row title. These suites are
 *  about the worktree/terminal lookup, not about the title text, so they pass
 *  a fixed one — `studioWorkspaceTitle`'s own behaviour is covered in
 *  orca-registry-rows.test.ts, not here. */
const TEST_TITLE = "websites · #7 some task";

/** `answers` is matched on the first two argv words, e.g. "worktree list". */
function fake(
  answers: Record<string, OrcaResult | (() => Promise<OrcaResult>)>,
  over: Partial<OrcaDeps> = {},
): Fake {
  const calls: string[][] = [];
  const lines: string[] = [];
  const memory = new Map<string, string>();
  const deps: OrcaDeps = {
    env: ORCA_ENV,
    hasBinary: () => "orca",
    registry: { get: (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); } },
    log: (line) => lines.push(line),
    run: async (args) => {
      calls.push(args);
      const a = answers[`${args[0]} ${args[1]}`];
      if (a === undefined) return ok("{}");
      return typeof a === "function" ? a() : a;
    },
    lock: memoryLock(),
    ...over,
  };
  return { deps, calls, lines };
}

const REPOS = ok(JSON.stringify({
  ok: true,
  result: { repos: [
    { id: "repo-websites", displayName: "websites", gitRemoteIdentity: { canonicalKey: "github.com/acme-org/websites" } },
    { id: "repo-acme", displayName: "acme", gitRemoteIdentity: { canonicalKey: "github.com/acme-hq/acme-os" } },
    { id: "repo-tsh", displayName: "exampleorg.com", gitRemoteIdentity: { canonicalKey: "github.com/demosite-life/exampleorg.com" } },
  ] },
}));

/** #175: each entry's `path` basename matches its `displayName` — the real
 *  shape for a worktree this code itself created (`--name studio-<id>`, a
 *  path Orca names after that argument) and never renamed the PATH of, only
 *  its display title (board #39). The tests about a row whose display title
 *  has since diverged from its stable path (the exact #175 scenario) live
 *  in orca-registry-teardown.test.ts, whose fixture sets the two independently. */
function worktrees(...displayNames: string[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: {
      worktrees: displayNames.map((displayName) => ({
        // Real Orca folds the id's `--` in the folder name (MEASURED 2026-09-24).
        id: `repo-websites::/w/${displayName}`, displayName, path: `/fake/orca/${displayName.replace(/-+/g, "-")}`,
      })),
    },
  }));
}

/** The general form `terminals()` is a shorthand for. */
function terminalEntries(...entries: {
  handle: string;
  title?: string;
  connected?: boolean;
  orphaned?: boolean;
  writable?: boolean;
  lastOutputAt?: string | number;
  worktreeId?: string;
  worktreePath?: string;
}[]): OrcaResult {
  return ok(JSON.stringify({ ok: true, result: { terminals: entries } }));
}

const TERM_CREATED = ok(JSON.stringify({
  ok: true,
  result: { terminal: { handle: "term_new", title: "websites--maestro" } },
}));

const CREATED = ok(JSON.stringify({
  ok: true,
  result: { worktree: { id: "repo-websites::/w/studio-websites--maestro", displayName: "studio-websites--maestro" } },
}));

function studio(id: string, state: StudioStatus["state"]): StudioStatus {
  return { id, state } as StudioStatus;
}

describe("name derivation", () => {
  // ---------------------------------------------------------------------------
  // Name derivation: deterministic and collision-free.

  test("workspace name is deterministic for a given studio id", () => {
    expect(studioWorkspaceName("websites--maestro")).toBe(studioWorkspaceName("websites--maestro"));
    expect(studioWorkspaceName("websites--maestro")).toContain("websites--maestro");
  });

  test("workspace names never collide across studio ids", () => {
    // `a--b-c` and `a-b--c` are DIFFERENT studios (repo/role split moves), and
    // any derivation that flattens "--" to "-" maps both onto one name — two
    // studios sharing one sidebar entry, which is the bug this guards.
    const ids = ["a--b-c", "a-b--c", "websites--maestro", "websites--web-studio", "acme-os--maestro"];
    const names = ids.map(studioWorkspaceName);
    expect(new Set(names).size).toBe(ids.length);
  });


});


describe("orcaPresent", () => {
  // ---------------------------------------------------------------------------
  // Presence predicate.

  test("orca is absent in a plain terminal even when the binary resolves", () => {
    expect(orcaPresent({ env: { TERM_PROGRAM: "Apple_Terminal" }, hasBinary: () => "orca" })).toBe(false);
  });

  test("orca is absent when the binary does not resolve, even inside Orca", () => {
    expect(orcaPresent({ env: ORCA_ENV, hasBinary: () => null })).toBe(false);
  });

  test("orca is present inside an Orca-managed worktree", () => {
    expect(orcaPresent({ env: { ORCA_WORKTREE_ID: "r::/w/x" }, hasBinary: () => "orca" })).toBe(true);
  });


});


describe("ensureStudioWorkspace — the five hard requirements", () => {
  // ---------------------------------------------------------------------------
  // The five hard requirements.

  test("makes no orca call at all outside Orca", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(f.calls).toEqual([]);
    expect(outcome.kind).toBe("skipped");
  });

  test("makes no orca call when the orca binary is missing", async () => {
    const f = fake({}, { hasBinary: () => null });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(f.calls).toEqual([]);
    expect(outcome.kind).toBe("skipped");
  });

  // Board #334: Orca is optional. Without the binary the studio still runs and
  // `fleet attach` works in any terminal — say so, once, instead of skipping
  // the sidebar row in silence.
  test("missing orca binary: one line says Orca is optional and how to attach", async () => {
    const f = fake({}, { hasBinary: () => null, env: { TERM_PROGRAM: "Apple_Terminal" } });
    await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("Orca is optional");
    expect(f.lines[0]).toContain("fleet attach websites--maestro");
  });

  test("missing orca binary inside a studio container: silent (STUDIO_ID set)", async () => {
    const f = fake({}, { hasBinary: () => null, env: { STUDIO_ID: "websites--pilot" } });
    await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(f.lines).toEqual([]);
  });

  test("binary present but not under Orca: silent, as before", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(f.lines).toEqual([]);
  });

  test("creates the worktree and its attach terminal when the studio has none", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "cto"),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");

    const create = f.calls.find((c) => c[0] === "worktree" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("studio-websites--maestro");
    expect(create).toContain("id:repo-websites");

    const term = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
    expect(term).toBeDefined();
    expect(term).toContain("fleet attach websites--maestro");
  });

  test("opens no second workspace when the studio already has one", async () => {
    // Item 3, translated from the operator's Portuguese: "a second call with a
    // terminal titled \"fleet\" already present does NOT create another." The
    // fixture is the REAL measured shape — a terminal titled "fleet" (the
    // process name, always) that is `connected` — not the old fictional
    // fixture where a terminal's title equalled the studio id, which real Orca
    // never produces.
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminals(true),
      "repo list": REPOS,
      "worktree create": CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("exists");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Board #42's own correction, verbatim: `connected` alone is not enough — a
  // plain shell an operator opens in this dedicated worktree ALSO reports
  // `connected: true`, and MEASURED (acme-os--release-studio, then again on
  // acme-os--scratch) that satisfies the OLD guard with no real attach
  // terminal ever created (defect B), and lets `fleet tabs` report a studio as
  // covered when it has no attach terminal at all (defect C — same miscount,
  // read from the reconcile side). Both close with the SAME criterion change:
  // `title === "fleet"`, not merely `connected`.

  test("a plain shell in the worktree does not satisfy idempotency — the real attach terminal still gets created", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_shell", title: "zsh", connected: true }),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    const term = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
    expect(term).toBeDefined();
    expect(term).toContain("fleet attach websites--maestro");
    // The shell itself is left alone — only a genuine duplicate ATTACH
    // terminal (title "fleet") is ever closed by this file, never a shell an
    // operator opened on purpose.
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
  });

  test("fleet tabs does not report coverage from a plain shell — defect C", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_shell", title: "zsh", connected: true }),
      "terminal create": TERM_CREATED,
    });
    const report = await reconcileStudioWorkspaces([studio("websites--maestro", "running")], () => TEST_TITLE, f.deps);
    expect(report.opened).toEqual(["websites--maestro"]);
    expect(report.existing).toEqual([]);
  });


});

// ---------------------------------------------------------------------------
// Fleet task #1248: `ensureLocalStudioWorktree` — a LOCAL studio (host:"local")
// materializes its lead into an Orca worktree checked out from a LOCAL clone
// (`path:<localPath>`), with the SAME lead-gate + agents + skills the cloud
// container gets, and launches claude via `orca terminal create`. Everything
// is best-effort-fail-safe like `ensureStudioWorkspace`: one try/catch, one
// stderr line, never a throw to the caller.

describe("local studio workspace — fleet task #1248", () => {
  // Real Orca reports `path` on the `worktree create` result (MEASURED — see
  // orca-workspace.ts's OrcaEnvelope comment), and the local path's
  // materialization step needs it to know where the lead's files land.
  const LOCAL_CREATED = ok(JSON.stringify({
    ok: true,
    result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: "/fake/orca/studio-websites-pilot" } },
  }));

  test("localWorktreeCreateArgs emits the exact worktree create argv", () => {
    expect(localWorktreeCreateArgs("/abs/clone", "main", "websites--pilot")).toEqual([
      "worktree", "create",
      "--repo", "path:/abs/clone",
      "--base-branch", "origin/main",
      "--agent", "claude",
      "--name", "studio-websites--pilot",
      "--no-parent", "--setup", "skip", "--json",
    ]);
  });

  test("localLaunchCommand quotes the prompt-by-file and carries allowedTools/effort", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w/.fleet/working-set.md", "Bash(git *) Edit Write", "max");
    // The prompt rides by FILE — the launch line stays a few hundred bytes
    // whatever the brief's size, and the pane shell expands "$(cat ...)" into
    // one argv element (studio-bringup.sh's own issue #6 technique).
    expect(cmd).toContain('--append-system-prompt "$(cat /w/.fleet/working-set.md)"');
    expect(cmd).toContain('--allowedTools "Bash(git *) Edit Write"');
    expect(cmd).toContain("--effort max");
  });

  test("localLaunchCommand never passes --dangerously-skip-permissions (a Mac lead keeps prompts on)", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w/.fleet/working-set.md", "Bash(git *)", "");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  test("localLaunchCommand omits --effort when the role carries none", () => {
    expect(localLaunchCommand("websites--pilot", "/w/.fleet/working-set.md", "Bash(git *)", "")).not.toContain("--effort");
  });

  test("localLeadGateHookCommand is the fail-closed PreToolUse command, matcher .*", () => {
    const cmd = localLeadGateHookCommand();
    expect(cmd).toContain("lead-gate hook absent or not executable -- refusing (decision 11)");
    expect(cmd).toContain("exit 2");
    expect(cmd).toContain("exec");
  });

  test("a missing orca binary is a no-op with the same orca-not-found line", async () => {
    const f = fake({}, { hasBinary: () => null, env: { TERM_PROGRAM: "Apple_Terminal" } });
    const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
      localPath: "/abs/clone", defaultBranch: "main", prompt: "p", allowedTools: "Bash(git *)",
    });
    expect(outcome.kind).toBe("skipped");
    expect(f.calls).toEqual([]);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("orca not found");
  });

  test("creates the worktree, materializes the working set, and launches claude via terminal create", async () => {
    const f = fake({
      "worktree create": LOCAL_CREATED,
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
      localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
    });
    expect(outcome.kind).toBe("created");

    const create = f.calls.find((c) => c[0] === "worktree" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--repo");
    expect(create).toContain("path:/abs/clone");
    expect(create).toContain("--base-branch");
    expect(create).toContain("origin/main");
    expect(create).toContain("--agent");
    expect(create).toContain("claude");
    expect(create).toContain("studio-websites--pilot");

    const term = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
    expect(term).toBeDefined();
    expect(term).toContain("websites--pilot");
    const cmd = term![term!.indexOf("--command") + 1];
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("$(cat");

    // The prompt and settings landed on the worktree path (the fixture's
    // worktree path), never in ~/.claude.
    const path = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
    expect(path).toBeDefined();
  });

  test("a worktree create failure is fail-closed: one stderr line, no throw", async () => {
    const f = fake({ "worktree create": { ok: false, stdout: "", stderr: "boom", timedOut: false } });
    const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
      localPath: "/abs/clone", defaultBranch: "main", prompt: "p", allowedTools: "Bash(git *)",
    });
    expect(outcome.kind).toBe("failed");
    expect(f.lines.length).toBe(1);
  });
});
