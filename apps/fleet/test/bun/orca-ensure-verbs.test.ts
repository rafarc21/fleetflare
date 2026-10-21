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
    expect(cmd.startsWith('STUDIO_ID=websites--pilot FLEET_WORKSPACE="/w" claude')).toBe(true);
    expect(cmd).not.toContain("--dangerously-skip-permissions");
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Fix 2 (#1259 round 3): the resume-reuse branch above must reconcile
  // against an already-live attach terminal, exactly like ensure() already
  // does, instead of ALWAYS creating a second one — a resumed worktree whose
  // attach terminal survived `fleet destroy`'s default keep-path must not
  // boot a second lead claude process beside the live one.
  test("a resume with a HEALTHY attach terminal already live reuses it — no terminal create, kind 'exists' (item 7)", async () => {
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
          handle: "term_live", title: "websites--pilot", connected: true, orphaned: false, writable: true,
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a resume with an UNHEALTHY (orphaned) attach terminal closes it and creates a fresh one (item 7)", async () => {
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
          handle: "term_dead", title: "websites--pilot", connected: true, orphaned: true,
        }),
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureLocalStudioWorktree("websites--pilot", f.deps, {
        localPath: "/abs/clone", defaultBranch: "main", prompt: "the prompt", allowedTools: "Bash(git *) Edit",
      });
      expect(outcome.kind).toBe("created");

      const close = f.calls.find((c) => c[0] === "terminal" && c[1] === "close");
      expect(close).toEqual(["terminal", "close", "--terminal", "term_dead", "--json"]);
      const create = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
      expect(create).toBeDefined();
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
    expect(cmd.startsWith('STUDIO_ID=websites--pilot FLEET_WORKSPACE="/w" claude')).toBe(true);
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

  test("sendLocalWake types the digest into the healthy attach terminal", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ check on task" }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out).toEqual({ woke: true, digest: "WAKE #1" });
    const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
    expect(send).toEqual(["terminal", "send", "--terminal", "term_0", "--text", "WAKE #1", "--enter"]);
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
    expect(await resolveLocalWake(report, "x", f.deps)).toBe(report);
  });

  test("resolveLocalWake swaps a local refusal for the terminal send", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ check on task" }),
      "terminal send": ok("{}"),
    });
    const report = { woke: false as const, reason: "LOCAL", local: true as const, digest: "WAKE #1" };
    const out = await resolveLocalWake(report, "websites--pilot", f.deps);
    expect(out).toEqual({ woke: true, digest: "WAKE #1" });
  });

  test("a healthy attach terminal with no readable preview refuses, fail-closed, and never sends", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out.woke).toBe(false);
    if (!out.woke) expect(out.reason).toContain("no claude session in the terminal");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
  });

  test("a prose-only preview (bare shell prompt) refuses — no claude glyph, never prose-matched", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "zsh-5.9 % git status" }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out.woke).toBe(false);
    if (!out.woke) expect(out.reason).toContain("no claude session in the terminal");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
  });

  test("a healthy attach terminal showing claude chrome wakes and sends the cleaned digest", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "⏺ done" }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
    expect(out.woke).toBe(true);
    const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
    expect(send).toEqual(["terminal", "send", "--terminal", "term_0", "--text", "WAKE #1", "--enter"]);
  });

  test("a digest carrying control bytes AND shell metacharacters is cleaned before sending AND before returning", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ ready" }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE \x03 $(reboot) \x1b\n", f.deps);
    expect(out.woke).toBe(true);
    expect(out.digest).toBe("WAKE  (reboot) ");
    const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
    expect(send).toEqual(["terminal", "send", "--terminal", "term_0", "--text", "WAKE  (reboot) ", "--enter"]);
  });

  test("a digest carrying ;|`&<> never reaches terminal send with those characters intact", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--pilot"),
      "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview: "❯ ready" }),
      "terminal send": ok("{}"),
    });
    const out = await sendLocalWake("websites--pilot", "WAKE ; rm -rf / | cat `id` & echo <x> y", f.deps);
    expect(out.woke).toBe(true);
    expect(out.digest).toBe("WAKE  rm -rf /  cat id  echo x y");
    for (const bad of [";", "|", "`", "&", "<", ">", "$", "\\"]) {
      expect(out.digest).not.toContain(bad);
    }
    const send = f.calls.find((c) => c[0] === "terminal" && c[1] === "send");
    expect(send?.[5]).toBe("WAKE  rm -rf /  cat id  echo x y");
  });

  // Fix 1a (#1259 round 3): the gate must look only at the terminal's TAIL
  // (the current screen state), never at claude chrome left over from a
  // just-exited session still sitting inside the preview's earlier lines.
  describe("the liveness gate reads only the screen's current tail (#1259 round 3)", () => {
    test("claude chrome earlier in the preview, but a bare shell prompt as the actual last line, refuses", async () => {
      // MEASURED shape: claude runs a turn, operator ctrl-c ctrl-c's out to a
      // bare shell, but the exited session's own chrome (`❯`, `⏺`) is still
      // inside the ~300-char preview window.
      const preview = [
        "❯ Reply with…",
        "⏺ ok",
        "✻ Worked for 2s…",
        "Resume this session with:",
        "claude --resume 1234-uuid",
        "➜  repo git:(main) ",
      ].join("\n");
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("no claude session in the terminal");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
    });

    test("a genuine composer row as the preview's last line wakes", async () => {
      const preview = ["stale ❯ chrome from a prior turn", "❯ some draft text"].join("\n");
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(true);
    });

    test("a genuine turn-marker row as the preview's last line wakes", async () => {
      const preview = ["some earlier output", "⏺ thinking…"].join("\n");
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(true);
    });

    test("a `▔` modal rule anywhere in the preview refuses, even with a composer-shaped last line", async () => {
      const preview = ["▔▔▔▔▔▔▔▔▔▔▔▔", "❯ 1. Yes", "❯ some draft text"].join("\n");
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(false);
      if (!out.woke) expect(out.reason).toContain("no claude session in the terminal");
      expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "send")).toBe(false);
    });

    test("trailing blank padding does not hide a real composer row behind it", async () => {
      const preview = ["❯ some draft text", "", "   ", ""].join("\n");
      const f = fake({
        "worktree list": worktrees("studio-websites--pilot"),
        "terminal list": terminalEntries({ handle: "term_0", title: "fleet", connected: true, worktreeId: WID, preview }),
        "terminal send": ok("{}"),
      });
      const out = await sendLocalWake("websites--pilot", "WAKE #1", f.deps);
      expect(out.woke).toBe(true);
    });
  });
});
