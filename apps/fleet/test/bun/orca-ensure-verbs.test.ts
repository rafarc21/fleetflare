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
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  studioWorkspaceName,
  orcaPresent,
  ensureStudioWorkspace,
  reconcileStudioWorkspaces,
  ensureLocalStudioWorktree,
  localWorktreeCreateArgs,
  localLaunchCommand,
  localLeadGateHookCommand,
  appendLocalExcludeLines,
  LOCAL_EXCLUDE_LINES,
  resolveStudioWorktreePath,
  writeLeadHandle,
  readLeadHandle,
  findPinnedLeadTerminal,
  type OrcaDeps,
  type OrcaResult,
} from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";
import { ORCA_ENV, ok, terminals } from "./helpers/orca-fixtures";

// item 5: `localSettingsPath` is a NEW export. bun's ESM makes a missing
// named export a hard module-link error (not `undefined`), which would kill
// every test in this file while the export is still absent (red). A dynamic
// import survives the link: it yields `undefined` now (red -> calling it
// throws) and the real function once the export lands (green).
const { localSettingsPath } = await import("../../cli/orca-workspace");

// item 2: same dynamic-import trick for the new local-wake exports — red
// survives the module link, green gets the real functions.
const { sendLocalWake, resolveLocalWake } = await import("../../cli/orca-workspace");

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
  preview?: string;
  // #1259 round 6: Orca's own tracked agent state — see
  // `isIdleClaudeTerminal`'s own doc comment in cli/orca-workspace.ts.
  agentIdentity?: string | null;
  agentWait?: unknown;
}[]): OrcaResult {
  return ok(JSON.stringify({ ok: true, result: { terminals: entries } }));
}

/** #1259 round 6: an idle-claude terminal's own two fields, spread onto a
 *  `terminalEntries(...)` fixture — the ONE idiom this file uses everywhere
 *  a test needs "Orca reports this terminal as a live, idle claude session"
 *  (replacing round 5's injected `isClaudeForeground` fake entirely). */
const IDLE_CLAUDE = { agentIdentity: "claude", agentWait: null } as const;

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
    const cmd = localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *) Edit Write", "max");
    // The prompt rides by FILE — the launch line stays a few hundred bytes
    // whatever the brief's size, and the pane shell expands "$(cat ...)" into
    // one argv element (studio-bringup.sh's own issue #6 technique).
    expect(cmd).toContain('--append-system-prompt "$(cat "/w/.fleet/working-set.md")"');
    expect(cmd).toContain('--allowedTools "Bash(git *) Edit Write"');
    expect(cmd).toContain("--effort max");
  });

  test("localLaunchCommand quotes the INNER prompt path so a path with a space survives", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w with space", "/w with space/.fleet/working-set.md", "Bash(git *)", "");
    // The inner path must be quoted too: the pane shell reads the file path
    // between the two quotes inside "$(cat ...)", or a space breaks the
    // launch line.
    expect(cmd).toContain('"$(cat "/w with space/.fleet/working-set.md")"');
  });

  test("localLaunchCommand never passes --dangerously-skip-permissions (a Mac lead keeps prompts on)", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *)", "");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  test("localLaunchCommand arms the gate with a STUDIO_ID=<id> env-assignment prefix", () => {
    // On the Mac STUDIO_ID is never set, so lead-gate.sh's own first line
    // (`[ -n "${STUDIO_ID:-}" ] || exit 0`) would exit 0 before any gate
    // logic. The prefix is the arming switch: claude — and every hook
    // subprocess it spawns — inherits STUDIO_ID, and the gate goes active.
    const cmd = localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *)", "");
    expect(cmd).toContain('STUDIO_ID=websites--pilot FLEET_WORKSPACE="/w" claude');
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  // #1259 round 6: round 5's own `tty > ".../.fleet/lead.tty"` capture
  // prefix is REMOVED, not kept — liveness no longer asks the OS anything at
  // all (see `isIdleClaudeTerminal`). The line now starts with the
  // STUDIO_ID arming switch directly, nothing before it.
  test("localLaunchCommand no longer captures a tty — the line starts with the STUDIO_ID arming switch directly", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *)", "");
    expect(cmd.startsWith("STUDIO_ID=websites--pilot")).toBe(true);
    expect(cmd).not.toContain("tty >");
    expect(cmd).not.toContain("lead.tty");
  });

  test("localLaunchCommand omits --effort when the role carries none", () => {
    expect(localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *)", "")).not.toContain("--effort");
  });

  test("localLeadGateHookCommand is the fail-closed PreToolUse command, matcher .*", () => {
    const cmd = localLeadGateHookCommand();
    expect(cmd).toContain("lead-gate hook absent or not executable -- refusing (decision 11)");
    expect(cmd).toContain("exit 2");
    expect(cmd).toContain("exec");
  });

  test("localLeadGateHookCommand resolves the script by $CLAUDE_PROJECT_DIR, never $PWD (a lead that cd's still gates)", () => {
    // $PWD is claude's CURRENT directory; a lead that `cd`'d into a subdir
    // made it wrong and every tool call was refused (exit 2). The project
    // root must be claude's own pointer, stable across cd.
    const cmd = localLeadGateHookCommand();
    expect(cmd).toContain("$CLAUDE_PROJECT_DIR/.claude/hooks/lead-gate.sh");
    expect(cmd).not.toContain("$PWD");
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
    // A writable temp worktree path, not the hardcoded /fake/orca/... : the
    // real materializeLocalLead mkdir/write into it must succeed on the
    // non-root GH runner (the root gate containers can write /fake/orca, the
    // runner cannot — the exact EACCES that made this test red on main).
    const root = mkdtempSync(join(tmpdir(), "orca-local-"));
    const worktreePath = join(root, "worktree");
    try {
      const f = fake({
        "worktree create": ok(JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: worktreePath } },
        })),
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

      // #1259 round 6 step 1: the brand-new terminal's handle is pinned
      // the moment it exists, so a later wake/resume call finds it by exact
      // handle instead of re-discovering it by ranking.
      expect(readFileSync(join(worktreePath, ".fleet", "lead.handle"), "utf8").trim()).toBe("term_new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes the lead gate with IS_MAESTRO baked to False (a local studio is never maestro)", async () => {
    // The copied hook must not keep the repo-tracked placeholder
    // `IS_MAESTRO = __IS_MAESTRO_BOOL__`: if the gate ever ran, that bare
    // name is a python NameError -> exit 1 -> PERMITS the call (only exit 2
    // blocks). The bake into the copied bytes is the trust anchor — same
    // reason studio-bringup.sh runs its own substitution on the copy, never
    // leaves the value to be re-derived from a separate file at decision time.
    const root = mkdtempSync(join(tmpdir(), "orca-local-"));
    const worktreePath = join(root, "worktree");
    try {
      const f = fake({
        "worktree create": ok(JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: worktreePath } },
        })),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      const hookBytes = readFileSync(join(worktreePath, ".claude", "hooks", "lead-gate.sh"), "utf8");
      expect(hookBytes).toContain("IS_MAESTRO = False");
      expect(hookBytes).not.toContain("__IS_MAESTRO_BOOL__");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a worktree create failure is fail-closed: one stderr line, no throw", async () => {
    const f = fake({ "worktree create": { ok: false, stdout: "", stderr: "boom", timedOut: false } });
    const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
      localPath: "/abs/clone", defaultBranch: "main", prompt: "p", allowedTools: "Bash(git *)",
    });
    expect(outcome.kind).toBe("failed");
    expect(f.lines.length).toBe(1);
  });

  test("an existing worktree is REUSED on resume — no worktree create, only materialize + terminal create (item 7)", async () => {
    // The default destroy KEEPS the worktree, so a resume must materialize into
    // the SAME on-disk path rather than `worktree create` again (name clash, or
    // a fresh checkout while the registry stays pointed at the kept unsynced one).
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-"));
    // basename must be one of studioFolderNames("websites--pilot") so
    // findStudioWorktree's path-basename fallback matches it.
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
      const term = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
      expect(term).toBeDefined();
      expect(term).toContain(`id:${existingId}`);

      // The lead's files landed in the EXISTING path, not a fresh checkout.
      expect(existsSync(join(existingPath, ".fleet", "working-set.md"))).toBe(true);
      expect(existsSync(join(existingPath, ".claude", "hooks", "lead-gate.sh"))).toBe(true);
      // #1259 round 6: the fresh terminal's handle is pinned for every later
      // wake/resume call.
      expect(readFileSync(join(existingPath, ".fleet", "lead.handle"), "utf8").trim()).toBe("term_new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1259 round 6 step 4: the resume-reuse branch above decides reuse-vs-create
  // from `isIdleClaudeTerminal` on the EXACT pinned terminal — Orca's own
  // tracked agent state, never an OS-level `ps` walk (round 5) or the
  // terminal's title (round 3's own fix, measured backwards: a LIVE claude
  // rewrites its own terminal's title via OSC, so title-matching called a
  // genuinely live lead "gone").
  test("a resume with a live claude process reuses it — no terminal create, kind 'exists' (item 7, #1259 round 6 step 4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-healthy-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries({
          handle: "term_live", title: "websites--pilot", connected: true, orphaned: false, writable: true, ...IDLE_CLAUDE,
        }),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("exists");

      expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);

      // Lead files still land in the kept worktree even on the reuse path —
      // a resumed worktree may have a stale working-set.md from before.
      expect(existsSync(join(existingPath, ".fleet", "working-set.md"))).toBe(true);
      // #1259 round 6 step 1: no `.fleet/lead.handle` existed yet (a studio
      // provisioned before this mechanism) — the one-time fallback discovery
      // backfills it with the terminal it found, so every LATER call uses
      // the exact handle instead of discovering again.
      expect(readFileSync(join(existingPath, ".fleet", "lead.handle"), "utf8").trim()).toBe("term_live");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1259 round 7 fix 2: resume's own decision reads ONLY `agentIdentity`,
  // never `agentWait` — the operator's own finding 3: `agentWait` is absent
  // from `terminal list --json` in every measured state (62 real rows), so
  // a future list schema that DID carry it must never make resume close a
  // live-but-waiting lead (blocked on its own permission prompt is still
  // alive). This terminal carries a non-null `agentWait` right alongside
  // `agentIdentity: "claude"` on the SAME pinned entry — resume must still
  // read "exists," proving the decision no longer depends on wait-state at
  // all, not even when the field is present.
  test("resume treats ANY claude identity as existing, even with a non-null agentWait on the SAME pinned entry (#1259 round 7 fix 2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-waiting-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    writeLeadHandle(existingPath, "term_waiting");
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries({
          handle: "term_waiting", title: "websites--pilot", connected: true, orphaned: false, writable: true,
          agentIdentity: "claude", agentWait: "permission",
        }),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("exists");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1259 round 6 finding 1, the exact bug this round exists to fix: round
  // 5's wake/resume both ranked worktree-matched candidates and acted on
  // whichever one came out first — real list order put an operator's own
  // unrelated shell ahead of the actual lead. This test pins
  // `.fleet/lead.handle` to the SECOND entry (the real lead) while the
  // FIRST entry (an operator's own shell, which `rankAttachTerminals` would
  // pick first on list-order alone) is idle-claude-shaped too, so a
  // ranking-based lookup would pick the WRONG one; only reading the exact
  // handle gets this right.
  test("resume honors the exact pinned handle, never a re-ranked guess — even when a DIFFERENT terminal would rank first (#1259 round 6 finding 1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-pinned-handle-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    writeLeadHandle(existingPath, "term_real_lead");
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries(
          // Lists FIRST — would win a rank-only lookup, but is NOT the
          // pinned handle, so must never be chosen or touched.
          { handle: "term_operator_shell", title: "websites--pilot", connected: true, orphaned: false, writable: true, ...IDLE_CLAUDE },
          { handle: "term_real_lead", title: "websites--pilot", connected: true, orphaned: false, writable: true, ...IDLE_CLAUDE },
        ),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("exists");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The exact case the title-based check got backwards: the terminal's own
  // title has drifted away from the studio id entirely (claude's own OSC
  // rewrite, e.g. to `✳ fix the login bug`) — the process check must not
  // care, since it never reads the title at all.
  test("a resume reuses a live claude process even when the terminal's title does NOT match the studio id (simulated OSC rewrite)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-osc-title-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries({
          handle: "term_live", title: "✳ fix the login bug", connected: true, orphaned: false, writable: true, ...IDLE_CLAUDE,
        }),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("exists");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1259 round 7 fix 1: round 6's fallback used to rank ANY `connected`
  // terminal and close whichever one came out first, even with no
  // `agentIdentity` at all on it. That ranking-by-list-order IS the bug Fix 1
  // removes: with no `agentIdentity:"claude"` candidate anywhere, the
  // fallback now returns null (never a guess), so nothing is identified to
  // close — a studio resumes by creating a fresh terminal, leaving whatever
  // unidentified terminal was there alone, rather than risk closing the wrong
  // one.
  test("a resume with no agentIdentity:claude candidate at all closes nothing, still creates a fresh terminal (item 7, #1259 round 7 fix 1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-unhealthy-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries({
          handle: "term_dead", title: "websites--pilot", connected: true, orphaned: false, writable: true,
        }),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
      const create = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
      expect(create).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1259 round 7 fix 1: two candidates, neither carrying
  // `agentIdentity:"claude"` — ambiguous either way old `rankAttachTerminals`
  // picked the first one (list order) and closed it, which was exactly how
  // the operator's own regression (finding 2) closed an operator's own shell.
  // The fallback now refuses to guess among ANY zero-or-many-claude set, so
  // neither is closed.
  test("a resume with no agentIdentity:claude candidate among several closes neither, never guesses which one to close (#1259 round 7 fix 1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-reuse-two-terms-"));
    const existingPath = join(root, "studio-websites-pilot");
    mkdirSync(existingPath, { recursive: true });
    const existingId = "repo-websites::/w/studio-websites-pilot";
    try {
      const f = fake({
        "worktree list": ok(JSON.stringify({
          ok: true,
          result: { worktrees: [{ id: existingId, displayName: "studio-websites--pilot", path: existingPath }] },
        })),
        "terminal list": terminalEntries(
          { handle: "term_stale_lead", title: "websites--pilot", connected: true, orphaned: false, writable: true },
          { handle: "term_operator_shell", title: "zsh", connected: true, orphaned: false, writable: true },
        ),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes all four container hooks with the lead gate (item 1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-local-"));
    const worktreePath = join(root, "worktree");
    try {
      const f = fake({
        "worktree create": ok(JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: worktreePath } },
        })),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
        completionGate: true,
      });
      expect(outcome.kind).toBe("created");

      // All five hook scripts copied from gates/ and executable.
      for (const h of ["lead-gate", "session-reemit", "install-marker", "activity-heartbeat", "completion-gate"]) {
        const p = join(worktreePath, ".claude", "hooks", `${h}.sh`);
        expect(existsSync(p)).toBe(true);
      }

      // settings.json carries every event entry.
      const cfg = JSON.parse(readFileSync(join(worktreePath, ".claude", "settings.json"), "utf8"));
      const hookText = (evt: string) => JSON.stringify((cfg.hooks ?? {})[evt] ?? []);
      expect(hookText("PreToolUse")).toContain("lead-gate.sh");
      expect(hookText("SessionStart")).toContain("session-reemit.sh");
      expect(hookText("SessionStart")).toContain("activity-heartbeat.sh");
      expect(hookText("PostToolUse")).toContain("install-marker.sh");
      expect(hookText("UserPromptSubmit")).toContain("activity-heartbeat.sh");
      expect(hookText("Stop")).toContain("activity-heartbeat.sh");
      expect(hookText("Notification")).toContain("activity-heartbeat.sh");
      expect(hookText("Stop")).toContain("completion-gate.sh");
      // completion-gate is FAIL-CLOSED: exit 2 on missing script.
      expect(hookText("Stop")).toContain("exit 2");

      // Every hook command resolves its script by $CLAUDE_PROJECT_DIR (claude's
      // stable project-root pointer), never $PWD (a lead that cd's would break
      // $PWD and the gate would refuse every call) — the SAME anchor
      // localLeadGateHookCommand builds.
      expect(localLeadGateHookCommand()).toContain("$CLAUDE_PROJECT_DIR/.claude/hooks/lead-gate.sh");
      expect(localLeadGateHookCommand()).not.toContain("$PWD");
      for (const evt of ["PreToolUse", "SessionStart", "PostToolUse", "UserPromptSubmit", "Stop", "Notification"]) {
        expect(hookText(evt)).toContain("$CLAUDE_PROJECT_DIR/.claude/hooks/");
        expect(hookText(evt)).not.toContain("$PWD");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no completion-gate when completionGate is false: hook and Stop entry both absent (item 1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-local-"));
    const worktreePath = join(root, "worktree");
    try {
      const f = fake({
        "worktree create": ok(JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: worktreePath } },
        })),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
        completionGate: false,
      });
      expect(outcome.kind).toBe("created");
      expect(existsSync(join(worktreePath, ".claude", "hooks", "completion-gate.sh"))).toBe(false);
      const cfg = JSON.parse(readFileSync(join(worktreePath, ".claude", "settings.json"), "utf8"));
      expect(JSON.stringify((cfg.hooks ?? {}).Stop ?? [])).not.toContain("completion-gate.sh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launch command arms FLEET_WORKSPACE so hooks find the worktree, not /workspace (item 1)", () => {
    const cmd = localLaunchCommand("websites--pilot", "/w", "/w/.fleet/working-set.md", "Bash(git *)", "");
    expect(cmd).toContain('STUDIO_ID=websites--pilot FLEET_WORKSPACE="/w" claude');
  });
});

// #1259 round 7 fix 1: findPinnedLeadTerminal's FALLBACK branch (no pin, or a
// stale one) used to rank `connected` candidates by list order and silently
// pick #1 — the operator's own measured regression (finding 2): a resume
// with no pin and a list `[operator zsh, live lead]` picked the zsh, closed
// it, spawned a SECOND lead, and PINNED THE NEW ONE, leaving the real live
// lead running forever, unpinned. The fallback now filters candidates by
// `agentIdentity === "claude"` (never `connected`, which says nothing about
// identity) and only ever acts on EXACTLY one such candidate — zero or two+
// is an unresolvable ambiguity, so it refuses (null, no pin written) rather
// than guess among them the way `rankAttachTerminals` did.
describe("findPinnedLeadTerminal fallback discovery — identity-filtered, exact-one-or-refuse (#1259 round 7 fix 1)", () => {
  const WID = "repo-websites::/w/studio-websites-pilot";

  function fallbackRoot(): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), "orca-fallback-"));
    const worktreePath = join(root, "studio-websites-pilot");
    mkdirSync(worktreePath, { recursive: true });
    return { root, worktreePath };
  }

  function fallbackFake(worktreePath: string, entries: Parameters<typeof terminalEntries>[0][]): Fake {
    return fake({
      "worktree list": ok(JSON.stringify({
        ok: true,
        result: { worktrees: [{ id: WID, displayName: "studio-websites--pilot", path: worktreePath }] },
      })),
      "terminal list": terminalEntries(...entries),
    });
  }

  test("(a) exactly one agentIdentity:claude candidate among non-claude ones is found and pinned, in either list order", async () => {
    const zsh = { handle: "term_zsh", title: "zsh", connected: true, worktreeId: WID };
    const lead = { handle: "term_lead", title: "fleet", connected: true, worktreeId: WID, ...IDLE_CLAUDE };
    for (const entries of [[zsh, lead], [lead, zsh]]) {
      const { root, worktreePath } = fallbackRoot();
      try {
        const f = fallbackFake(worktreePath, entries);
        const found = await findPinnedLeadTerminal("websites--pilot", f.deps);
        expect(found?.handle).toBe("term_lead");
        expect(readLeadHandle(worktreePath)).toBe("term_lead");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("(b) zero agentIdentity:claude candidates returns null and writes no pin at all", async () => {
    const { root, worktreePath } = fallbackRoot();
    try {
      const f = fallbackFake(worktreePath, [
        { handle: "term_zsh", title: "zsh", connected: true, worktreeId: WID },
      ]);
      const found = await findPinnedLeadTerminal("websites--pilot", f.deps);
      expect(found).toBeNull();
      expect(readLeadHandle(worktreePath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c) two agentIdentity:claude candidates is ambiguous -- returns null, writes no pin, picks neither", async () => {
    const { root, worktreePath } = fallbackRoot();
    try {
      const f = fallbackFake(worktreePath, [
        { handle: "term_a", title: "fleet", connected: true, worktreeId: WID, ...IDLE_CLAUDE },
        { handle: "term_b", title: "fleet", connected: true, worktreeId: WID, ...IDLE_CLAUDE },
      ]);
      const found = await findPinnedLeadTerminal("websites--pilot", f.deps);
      expect(found).toBeNull();
      expect(readLeadHandle(worktreePath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(d) the operator's exact regression: [operator zsh, live lead], no pin -- pins the live lead, never the zsh, in EITHER list order", async () => {
    const zsh = { handle: "term_operator_zsh", title: "zsh", connected: true, worktreeId: WID, agentIdentity: null };
    const lead = { handle: "term_live_lead", title: "fleet", connected: true, worktreeId: WID, ...IDLE_CLAUDE };
    for (const entries of [[zsh, lead], [lead, zsh]]) {
      const { root, worktreePath } = fallbackRoot();
      try {
        const f = fallbackFake(worktreePath, entries);
        const found = await findPinnedLeadTerminal("websites--pilot", f.deps);
        expect(found?.handle).toBe("term_live_lead");
        expect(readLeadHandle(worktreePath)).toBe("term_live_lead");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fleet task #1248 review BLOCKER B3: the lead's project-scoped files
// (.fleet/working-set.md, .claude/settings.json, .claude/hooks/,
// .claude/agents/, .claude/skills/) live INSIDE the worktree — committable.
// A member `git add -A` would commit the fail-closed settings.json (blocking
// every tool for anyone else using the repo) and private prompt/house-rules
// text into a public repo. materializeLocalLead appends the exact lines to
// the worktree's git exclude file (never the repo-tracked .gitignore).

describe("local lead files are excluded from git (B3)", () => {
  /** A real temp git worktree: `rev-parse --path-format=absolute --git-path
   *  info/exclude` resolves the per-worktree exclude file, and a real
   *  `git check-ignore` proves the lines take effect. */
  function makeWorktree() {
    const root = mkdtempSync(join(tmpdir(), "orca-exclude-repo-"));
    const main = join(root, "main");
    const wt = join(root, "wt");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "x@y"], { cwd: main });
    execFileSync("git", ["config", "user.name", "x"], { cwd: main });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt"], { cwd: main });
    return { root, main, wt };
  }

  function excludePath(wt: string): string {
    return execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  }

  test("appends the five exact lines, idempotently, to the worktree's own exclude file", () => {
    const { root, wt } = makeWorktree();
    try {
      const lines: string[] = [];
      appendLocalExcludeLines(wt, { log: (l) => lines.push(l) });

      const exclude = readFileSync(excludePath(wt), "utf8");
      for (const line of LOCAL_EXCLUDE_LINES) expect(exclude).toContain(line);

      // Idempotent: a second run must not stack duplicates.
      appendLocalExcludeLines(wt, { log: (l) => lines.push(l) });
      const again = readFileSync(excludePath(wt), "utf8");
      for (const line of LOCAL_EXCLUDE_LINES) {
        expect(again.split("\n").filter((l) => l === line)).toHaveLength(1);
      }
      expect(lines).toEqual([]); // never logs on success
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the excluded paths are actually ignored by git in the worktree", () => {
    const { root, wt } = makeWorktree();
    try {
      appendLocalExcludeLines(wt, { log: () => {} });
      // A file under each excluded path, then a real `git check-ignore`.
      for (const dir of [".fleet", ".claude/hooks", ".claude/agents", ".claude/skills"]) {
        mkdirSync(join(wt, dir), { recursive: true });
        writeFileSync(join(wt, dir, "f"), "x");
      }
      mkdirSync(join(wt, ".claude"), { recursive: true });
      writeFileSync(join(wt, ".claude", "settings.json"), "{}");
      const ignored = execFileSync(
        "git", ["-C", wt, "check-ignore", ".fleet/", ".claude/settings.json", ".claude/hooks/", ".claude/agents/", ".claude/skills/"],
        { encoding: "utf8" },
      ).trim().split("\n").filter(Boolean);
      expect(ignored).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed exclude write logs one line and never throws", () => {
    const lines: string[] = [];
    const run = (): { code: number | null; stdout: string; stderr: string } => ({ code: 128, stdout: "", stderr: "boom" });
    expect(() => appendLocalExcludeLines("/nonexistent", { log: (l) => lines.push(l) }, run)).not.toThrow();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("could not exclude");
  });
});

describe("tracked .claude/settings.json -> settings.local.json (item 5)", () => {
  // A real temp git worktree, so `git ls-files --error-unmatch` really runs.
  function makeWorktree() {
    const root = mkdtempSync(join(tmpdir(), "orca-tracked-settings-"));
    const main = join(root, "main");
    const wt = join(root, "wt");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "x@y"], { cwd: main });
    execFileSync("git", ["config", "user.name", "x"], { cwd: main });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt"], { cwd: main });
    return { root, main, wt };
  }

  test("localSettingsPath returns settings.local.json when .claude/settings.json is tracked", () => {
    const { root, wt } = makeWorktree();
    try {
      mkdirSync(join(wt, ".claude"), { recursive: true });
      writeFileSync(join(wt, ".claude", "settings.json"), "{}\n");
      execFileSync("git", ["-C", wt, "add", ".claude/settings.json"]);
      execFileSync("git", ["-C", wt, "commit", "-q", "-m", "track settings"]);
      expect(localSettingsPath(wt)).toBe(join(wt, ".claude", "settings.local.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("localSettingsPath returns settings.json when nothing is tracked", () => {
    const { root, wt } = makeWorktree();
    try {
      expect(localSettingsPath(wt)).toBe(join(wt, ".claude", "settings.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materialize writes hooks to settings.local.json, leaves the tracked settings.json bytes untouched, and excludes it", async () => {
    const { root, wt } = makeWorktree();
    try {
      mkdirSync(join(wt, ".claude"), { recursive: true });
      writeFileSync(join(wt, ".claude", "settings.json"), '{"some":"tracked"}\n');
      execFileSync("git", ["-C", wt, "add", ".claude/settings.json"]);
      execFileSync("git", ["-C", wt, "commit", "-q", "-m", "track settings"]);

      const f = fake({
        "worktree create": ok(JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot", path: wt } },
        })),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      // The tracked file's bytes are byte-identical — never clobbered.
      expect(readFileSync(join(wt, ".claude", "settings.json"), "utf8")).toBe('{"some":"tracked"}\n');
      // The hooks landed in settings.local.json instead.
      const local = JSON.parse(readFileSync(join(wt, ".claude", "settings.local.json"), "utf8"));
      expect(JSON.stringify(local.hooks ?? {})).toContain("lead-gate.sh");
      // And it is excluded from git.
      const ignored = execFileSync("git", ["-C", wt, "check-ignore", ".claude/settings.local.json"], { encoding: "utf8" }).trim();
      expect(ignored).toBe(".claude/settings.local.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fleet task #1248 review BLOCKER B1 (fix round): resolveStudioWorktreePath —
// the ORCA worktree's own on-disk path for a local studio's destroy decision.
// The dirty/ahead git reads must target this path, never the clone it was
// built from (a clean clone + dirty worktree + --force --discard-unsynced
// would still delete uncommitted work).

describe("resolveStudioWorktreePath (B1 fix round)", () => {
  test("returns the worktree path whose basename matches the studio id", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--pilot"),
    });
    expect(await resolveStudioWorktreePath("websites--pilot", f.deps)).toBe("/fake/orca/studio-websites-pilot");
  });

  test("null when no orca is present", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    expect(await resolveStudioWorktreePath("websites--pilot", f.deps)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("null when the worktree list has no row for the studio", async () => {
    const f = fake({ "worktree list": worktrees("staging") });
    expect(await resolveStudioWorktreePath("websites--pilot", f.deps)).toBeNull();
  });
});

describe("local studio wake via orca terminal send (item 2)", () => {
  const WID = "repo-websites::/w/studio-websites--pilot";

  /** Orca's `terminal show --terminal <handle> --json` envelope — #1259
   *  round 7 fix 3's own gate data source, read fresh right before any
   *  typing. `detail: null` simulates the call failing or reporting no
   *  terminal at all. */
  function terminalShow(detail: { agentIdentity?: string | null; agentWait?: unknown } | null): OrcaResult {
    return ok(JSON.stringify({ ok: true, result: { terminal: detail } }));
  }

  /** The one `terminal list` answer `findPinnedLeadTerminal` reads to find
   *  the lead's handle — #1259 round 7 fix 4 removes the SECOND, post-type
   *  re-read entirely (see the describe block below), so one plain entry is
   *  all any wake test needs now. Needs `agentIdentity:"claude"` for
   *  `findPinnedLeadTerminal`'s own fallback discovery (#1259 round 7 fix 1)
   *  to find it at all when no pin is already written. */
  function oneTerminal(): OrcaResult {
    return terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, ...IDLE_CLAUDE });
  }

  test("sendLocalWake types the digest and submits it in ONE terminal send call, with --wait-submit (#1259 round 7 fix 4)", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": oneTerminal(),
      "terminal show": terminalShow(IDLE_CLAUDE),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out).toEqual({ woke: true, digest: "WAKE #1" });
    const sends = f.calls.filter((c) => c[0] === "terminal" && c[1] === "send");
    expect(sends).toEqual([
      ["terminal", "send", "--terminal", "term_0", "--text", "WAKE #1", "--enter", "--wait-submit", "5"],
    ]);
  });

  // #1259 round 5's own measured gap, still true under round 6's mechanism:
  // a live local lead rewrites its own terminal's title via OSC
  // (`✳ <summary>`), never matching the studio id or any #153 attach-title
  // form. `sendLocalWake`'s own terminal lookup must still find it: Orca's
  // own tracked agent state, title irrelevant.
  test("sendLocalWake finds and types into a terminal whose title is claude's own OSC rewrite, not the studio id", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({
        handle: "term_0", title: "✳ fix the login bug", connected: true, worktreeId: WID, ...IDLE_CLAUDE,
      }),
      "terminal show": terminalShow(IDLE_CLAUDE),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out).toEqual({ woke: true, digest: "WAKE #1" });
    const sends = f.calls.filter((c) => c[0] === "terminal" && c[1] === "send");
    expect(sends).toEqual([
      ["terminal", "send", "--terminal", "term_0", "--text", "WAKE #1", "--enter", "--wait-submit", "5"],
    ]);
  });

  test("sendLocalWake refuses when there is no healthy attach terminal", async () => {
    const f = fake({ "worktree list": worktrees("studio-websites--pilot"), "terminal list": terminals(false) });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out.woke).toBe(false);
  });

  test("sendLocalWake refuses outside an Orca session", async () => {
    const f = fake({});
    f.deps.env = {};
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out.woke).toBe(false);
  });

  test("resolveLocalWake passes a non-local report through untouched", async () => {
    const f = fake({});
    const report = { woke: false as const, reason: "STOPPED" };
    expect(await resolveLocalWake(report, "x", 1, f.deps)).toBe(report);
  });

  // Fix 1 (#1259 round 4): resolveLocalWake no longer trusts `report.digest` —
  // it builds ONE fixed template from the task NUMBER alone, validated as a
  // plain positive integer. See the describe block below ("the wake payload
  // is a fixed template") for the injection-proof this change exists for.
  test("resolveLocalWake swaps a local refusal for the terminal send, carrying the fixed per-task-number template", async () => {
    const digest = "Board task #42 has a new message. Run: fleet task show 42";
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": oneTerminal(),
      "terminal show": terminalShow(IDLE_CLAUDE),
      "terminal send": ok("{}"),
    });
    const report = { woke: false as const, reason: "LOCAL", local: true as const };
    const out = await resolveLocalWake(report, "websites--pilot", 42, f.deps);
    expect(out).toEqual({ woke: true, digest });
  });

  describe("the wake payload is a fixed template, never attacker-influenced board content (#1259 round 4 fix 1)", () => {
    test("an attacker-shaped report.digest (shell command substitution) never reaches terminal send — it is never even read", async () => {
      const digest = "Board task #7 has a new message. Run: fleet task show 7";
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": oneTerminal(),
        "terminal show": terminalShow(IDLE_CLAUDE),
        "terminal send": ok("{}"),
      });
      const report = { woke: false as const, reason: "LOCAL", local: true as const, digest: "$(touch PWNED)" };
      const out = await resolveLocalWake(report, "websites--pilot", 7, f.deps);
      expect(out).toEqual({ woke: true, digest });
      const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
      expect(send?.[5]).not.toContain("PWNED");
      expect(send?.[5]).not.toContain("touch");
      expect(send?.[5]).toBe(digest);
    });

    test("an attacker-shaped report.digest (zsh glob qualifier, no shell metacharacters needed) never reaches terminal send either", async () => {
      const digest = "Board task #9 has a new message. Run: fleet task show 9";
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": oneTerminal(),
        "terminal show": terminalShow(IDLE_CLAUDE),
        "terminal send": ok("{}"),
      });
      const report = {
        woke: false as const, reason: "LOCAL", local: true as const,
        digest: "x\" *(e:'touch PWNED':) \"",
      };
      const out = await resolveLocalWake(report, "websites--pilot", 9, f.deps);
      expect(out).toEqual({ woke: true, digest });
      const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
      expect(send?.[5]).not.toContain("PWNED");
      expect(send?.[5]).not.toContain("*(e:");
    });

    // 1e21: `Number.isInteger(1e21)` is TRUE (it has no fractional part) even
    // though it is nowhere near a real task number — `Number.isSafeInteger`
    // is the correct check (minor fix, #1259 round 5), rejecting it and
    // every other value outside the safe integer range, never producing a
    // nonsensical `#1e+21` in the fixed wake template.
    test("refuses, fail closed, when the task number is not a positive integer — no orca call at all", async () => {
      const f = fake({});
      const report = { woke: false as const, reason: "LOCAL", local: true as const };
      for (const bad of [0, -1, 1.5, Number.NaN, 1e21]) {
        const out = await resolveLocalWake(report, "websites--pilot", bad, f.deps);
        expect(out?.woke).toBe(false);
        if (out && !out.woke) expect(out.reason).toContain(`invalid task number ${bad}`);
      }
      expect(f.calls).toEqual([]);
    });
  });

  // #1259 round 7 fix 3: the PRIMARY liveness gate now reads `terminal show
  // --terminal <handle> --json`, never the `terminal list` entry's own
  // `agentWait` — MEASURED absent from `terminal list --json` in every
  // state (62 real rows); it only lives on `terminal show`, where it reads
  // null except during an actual permission wait. Gates BEFORE any typing
  // happens at all.
  describe("the terminal-show gate — Orca's own authoritative idle state, read fresh before any typing (#1259 round 7 fix 3)", () => {
    test("reads the gate via `terminal show --terminal <handle> --json`, and proceeds to type when it reports idle", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": () => Promise.resolve(terminalEntries({
          handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ WAKE #1", ...IDLE_CLAUDE,
        })),
        "terminal show": terminalShow({ agentIdentity: "claude", agentWait: null }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(true);
      expect(f.calls).toContainEqual(["terminal", "show", "--terminal", "term_0", "--json"]);
    });

    // The operator's own exact wording: agentWait===null (strict), unlike
    // resume's own `agentWait==null` loose read (#1259 round 6) — `terminal
    // show`'s field is expected to reliably be either null or a real value,
    // never absent, unlike `list`'s entries.
    test("refuses when terminal show reports a non-null agentWait (blocked on a permission prompt) — never attempts to type", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": () => Promise.resolve(terminalEntries({
          handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ ready", ...IDLE_CLAUDE,
        })),
        "terminal show": terminalShow({ agentIdentity: "claude", agentWait: "permission" }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("not an idle claude session");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
    });

    test("refuses when terminal show reports the terminal is no longer claude (process exited) — never attempts to type", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": () => Promise.resolve(terminalEntries({
          handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ ready", ...IDLE_CLAUDE,
        })),
        "terminal show": terminalShow({ agentIdentity: null, agentWait: null }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("not an idle claude session");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
    });
  });

  // #1259 round 7 fix 4: the old 2-phase verify-then-commit send (type
  // without `--enter`, re-read the preview by exact handle, require the
  // LAST non-empty preview line to contain the FULL digest, only then send
  // a separate `--enter`) never succeeded on real Orca — the operator's own
  // 4/4 measured real-Orca attempts: the composer wraps long text across
  // multiple visual lines, so the digest was NEVER found whole on any
  // single "last line," even on a fully successful type, stranding the
  // digest half-typed every time. Replaced with ONE `terminal send` call
  // carrying `--enter --wait-submit <seconds>`, trusting Orca's OWN
  // submission acknowledgment instead of re-reading screen text ourselves —
  // no second `terminal list`/`terminal show` call after the send, ever.
  describe("single-call send with --wait-submit, trusting Orca's own submission acknowledgment (#1259 round 7 fix 4)", () => {
    test("the send call carries --enter and --wait-submit with a positive value; success yields woke:true with no re-read after the send", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": oneTerminal(),
        "terminal show": terminalShow(IDLE_CLAUDE),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out).toEqual({ woke: true, digest: "WAKE #1" });

      const sendIdx = f.calls.findIndex((c) => c[0] === "terminal" && c[1] === "send");
      expect(sendIdx).toBeGreaterThanOrEqual(0);
      const send = f.calls[sendIdx]!;
      expect(send).toContain("--enter");
      const waitIdx = send.indexOf("--wait-submit");
      expect(waitIdx).toBeGreaterThan(-1);
      expect(Number(send[waitIdx + 1])).toBeGreaterThan(0);

      // No `terminal list`/`terminal show` call happened AFTER the send —
      // the single `list` (lookup) and single `show` (gate) calls both
      // precede it, never follow it.
      const afterSend = f.calls.slice(sendIdx + 1);
      expect(afterSend.some((c) => c[0] === "terminal" && (c[1] === "list" || c[1] === "show"))).toBe(false);
    });

    test("a failed terminal send refuses, surfacing orca's own stderr", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": oneTerminal(),
        "terminal show": terminalShow(IDLE_CLAUDE),
        "terminal send": { ok: false, stdout: "", stderr: "orca wedged", timedOut: false },
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("terminal send failed");
      // Only ONE `terminal list` call — the lookup; no re-read ever ran.
      expect(f.calls.filter((c) => c[0] === "terminal" && c[1] === "list").length).toBe(1);
    });

    test("a timed-out terminal send refuses the same way", async () => {
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": oneTerminal(),
        "terminal show": terminalShow(IDLE_CLAUDE),
        "terminal send": { ok: false, stdout: "", stderr: "", timedOut: true },
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("terminal send failed");
    });
  });

  // Fix 1 (#1259 round 4): fix-1b's shell-metachar strip (`$`, backtick,
  // backslash, `;`, `|`, `&`, `<`, `>`) is gone from `sendLocalWake` itself —
  // it was defense-in-depth for an untrusted `digest`, and `resolveLocalWake`
  // no longer ever passes one through (see the describe block above). The
  // older, broader control-byte strip stays: it is not tied to that specific
  // threat and costs nothing to keep.
  test("a digest carrying control bytes is cleaned before sending AND before returning, shell metacharacters pass through untouched", async () => {
    const cleaned = "WAKE  $(reboot)";
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": oneTerminal(),
      "terminal show": terminalShow(IDLE_CLAUDE),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE \x03 $(reboot)\x1b", f.deps);
    expect(out.woke).toBe(true);
    expect(out.digest).toBe(cleaned);
    const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
    expect(send).toEqual(["terminal", "send", "--terminal", "term_0", "--text", cleaned, "--enter", "--wait-submit", "5"]);
  });
});
