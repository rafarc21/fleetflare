// `ensureStudioWorkspace` — every running studio gets its OWN Orca sidebar
// entry (a worktree), not a tab buried in whichever worktree happened to
// spawn it. the operator 2026-09-11: "I won't accept invisible things spending money
// in the cloud without me seeing it."
//
// bun:test lane, not the workerd lane: this is CLI code (Bun.which, Bun.spawn,
// process env), and vitest-pool-workers cannot host any of it. Every orca
// invocation is INJECTED, so no test here ever shells out to real Orca — the
// one test that does spawn a process (`never fails its caller`) runs a bun
// script that injects a throwing runner.
//
// The VERBS/RECONCILE half of old orca-ensure.test.ts, split per plan
// docs/maintainability/plans/2026-10-13-s35-f2-orca-ensure-split-795.md
// (issue #795): duplicate-terminal reconciliation, the `fleet tabs` reconcile
// verb, the #216 preview/plan verbs, and the exit-code process test. The
// sibling orca-ensure-verbs.test.ts carries the ensure-core half (name
// derivation, presence, ensureStudioWorkspace's five hard requirements);
// teardown lives in orca-registry-teardown.test.ts; registry, locks, and the
// ROW column live in orca-registry-rows.test.ts.
import { test, describe, expect } from "bun:test";
import { join } from "node:path";
import {
  ensureStudioWorkspace,
  reconcileStudioWorkspaces,
  previewStudioWorkspace,
  planStudioWorkspaces,
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
 *  per-key promise chain: exactly what board #42's race tests need to prove
 *  the fix actually serializes, without a real second OS process. */
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

describe("duplicate terminals — reconcile", () => {
  // ---------------------------------------------------------------------------
  // Board #42's mandatory TDD wording, second half: "a worktree carrying two
  // is reconciled to one." A duplicate already on disk (from before this fix
  // shipped, or from the race the lock above now closes) is not left for the
  // next reader to stumble on — `ensure()` itself closes every extra genuine
  // attach terminal down to the best one, every time it runs.

  test("a worktree already carrying two connected attach terminals is reconciled to one", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        // #220 fix round: a 1-hour gap is FAR past the 90s staleness window —
        // term_real stopped receiving frames long before term_dup's last one,
        // so it is now DEMOTED and term_dup (the fresher one) is kept, even
        // though term_real was listed first. Before #220 this pair was used to
        // pin "equally healthy — the earliest listed (oldest) is kept" with NO
        // regard for how far apart lastOutputAt was; that blanket rule is
        // exactly the gap #220's own review comment found (see the two tests
        // just below this one for the "still within 90s, oldest wins" and
        // "no lastOutputAt at all, oldest wins" cases that keep the old rule
        // alive for the cases it was actually meant for).
        { handle: "term_real", title: "fleet", connected: true, lastOutputAt: "2026-09-23T09:00:00Z" },
        { handle: "term_dup", title: "fleet", connected: true, lastOutputAt: "2026-09-23T10:00:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("exists");
    if (outcome.kind !== "exists") throw new Error("unreachable");
    expect(outcome.closedDuplicates).toEqual(["term_real"]);
    const closes = f.calls.filter((c) => c[0] === "terminal" && c[1] === "close");
    expect(closes.length).toBe(1);
    expect(closes[0]).toContain("term_real");
    // Never both — reconciling to one row's terminal, not zero.
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(false);
  });

  test("duplicate reconciliation prefers the writable, non-orphaned terminal over mere recency", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        // Newer `lastOutputAt`, but orphaned — a dead pty nobody is on.
        { handle: "term_orphaned", title: "fleet", connected: true, orphaned: true, lastOutputAt: "2026-09-23T12:00:00Z" },
        { handle: "term_healthy", title: "fleet", connected: true, writable: true, lastOutputAt: "2026-09-23T09:00:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error("unreachable");
    expect(outcome.closedDuplicates).toEqual(["term_orphaned"]);
  });

  test("fleet tabs surfaces a reconciled duplicate loudly, in its own report bucket", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_real", title: "fleet", connected: true },
        { handle: "term_dup", title: "fleet", connected: true, lastOutputAt: "2026-09-23T10:00:00Z" },
      ),
    });
    const report = await reconcileStudioWorkspaces([studio("websites--maestro", "running")], () => TEST_TITLE, f.deps);
    expect(report.existing).toEqual(["websites--maestro"]);
    expect(report.deduped).toEqual([{ id: "websites--maestro", closed: ["term_dup"] }]);
  });

  // ---------------------------------------------------------------------------
  // Board #42: the actual mechanism behind a duplicate attach terminal. Not a
  // trivial "call it twice sequentially" case — the existing `connected`-only
  // guard already makes THAT pass. The real bug is a check-then-act race: two
  // callers (e.g. `fleet spawn` and `fleet tabs` running near-simultaneously,
  // two separate `fleet` OS processes with no shared state) can both run
  // `terminal list`, both see no attach terminal yet, and both proceed to
  // `terminal create` before either's create has landed. Modeled here with two
  // CONCURRENT `ensureStudioWorkspace` calls against one shared, stateful fake
  // (adapted from board #39's own stateful fake in this file) — real interleaving
  // via microtask scheduling, no artificial timers, so it is deterministic.
  //
  // Confirmed RED against pre-fix code (no `deps.lock` at all): 2 `terminal
  // create` calls, not 1. `deps.lock` here is the in-memory stand-in
  // (`memoryLock`) for the real file-backed lock `ensureStudioWorkspace` now
  // wraps its whole check-then-act window in — this test is what proves that
  // wrapping actually serializes the two callers, not just that it compiles.
  test("two concurrent ensureStudioWorkspace calls for the same studio create only one attach terminal", async () => {
    const state: { connected: boolean; creates: number } = { connected: false, creates: 0 };
    const calls: string[][] = [];
    const concurrentMemory = new Map<string, string>();
    const deps: OrcaDeps = {
      env: ORCA_ENV,
      hasBinary: () => "orca",
      log: () => {},
      registry: {
        get: (k) => concurrentMemory.get(k),
        set: async (k, v) => { concurrentMemory.set(k, v); },
      },
      lock: memoryLock(),
      run: async (args) => {
        calls.push(args);
        const [a, b] = args;
        if (a === "worktree" && b === "list") return worktrees("studio-websites--maestro");
        if (a === "terminal" && b === "list") {
          // Every concurrent caller reads the SAME live state — the race is in
          // what happens between this read and the `terminal create` write
          // below, not in the fixture.
          return terminals(...(state.connected ? [true] : []));
        }
        if (a === "terminal" && b === "create") {
          state.creates += 1;
          state.connected = true;
          return TERM_CREATED;
        }
        return ok("{}");
      },
    };

    const [first, second] = await Promise.all([
      ensureStudioWorkspace("websites--maestro", TEST_TITLE, deps),
      ensureStudioWorkspace("websites--maestro", TEST_TITLE, deps),
    ]);

    const creates = calls.filter((c) => c[0] === "terminal" && c[1] === "create");
    expect(creates.length).toBe(1);
    expect(state.creates).toBe(1);
    expect([first.kind, second.kind].sort()).toEqual(["created", "exists"]);
  });

  // #1225: the real run must repair, not just report — a worktree that
  // survived an Orca restart while its attach terminal went DEAD gets the
  // dead terminal closed and a working one opened, so the run's "opened" line
  // matches the plan's "open (attach DEAD)" rather than silently skipping.
  test("#1225: ensure() closes a dead attach terminal and opens a working one", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_dead", title: "fleet", connected: true, orphaned: true }),
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    const closes = f.calls.filter((c) => c[0] === "terminal" && c[1] === "close");
    expect(closes.length).toBe(1);
    expect(closes[0]).toContain("term_dead");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(true);
  });

  test("re-opens only the attach terminal when the workspace exists without one", async () => {
    // "Exists without one" is represented as an EMPTY terminal list, not an
    // entry with `connected: false` — a terminal tied to a dead process/pty
    // is the more realistic way Orca would report a closed session (the
    // terminal object itself stops being listed), matching the worktree case
    // just above where "no attach terminal yet" is also an empty list.
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminals(),
      "worktree create": CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(true);
  });

  test("a brand-new worktree always creates its attach terminal, even if terminal list already shows a connected one", async () => {
    // Item 2 defensive fix: unconfirmed hypothesis that `orca worktree create`
    // may itself leave a default terminal behind, reporting `connected: true`
    // before `fleet attach <id>`'s own terminal ever gets created. On the
    // `created` (brand-new worktree) path, the idempotency shortcut must NOT
    // apply — the real attach terminal must always get created and renamed,
    // never skipped because of what a pre-existing entry reports.
    const f = fake({
      "worktree list": worktrees("staging"),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(true),
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    const term = f.calls.find((c) => c[0] === "terminal" && c[1] === "create");
    expect(term).toBeDefined();
    expect(term).toContain("fleet attach websites--maestro");
    const rename = f.calls.find((c) => c[0] === "terminal" && c[1] === "rename");
    expect(rename).toBeDefined();
    expect(rename).toContain("websites--maestro");
  });

  test("a timed-out orca call fails soft: one line, no throw", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "", timedOut: true } });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("failed");
    expect(f.lines.length).toBe(1);
    expect(f.lines[0]).toContain("timed out");
  });

  test("a throwing orca runner fails soft: one line, no throw", async () => {
    const f = fake({}, { run: async () => { throw new Error("spawn ENOENT"); } });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("failed");
    expect(f.lines.length).toBe(1);
  });

  test("stamps the attach terminal with a title that survives the process name", async () => {
    // MEASURED on real Orca 1.4.198: `terminal create --title X` does not hold.
    // Orca relabels a tab with the name of whatever is running in it, so a tab
    // created as "websites--maestro" reads back as "fleet" the moment
    // `fleet attach` starts — and a title match against the studio id then finds
    // nothing, so the NEXT spawn opens a second tab, forever. `terminal rename`
    // sets a custom title that does hold, so the stamp is a rename, not a flag.
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
      "terminal create": TERM_CREATED,
    });
    await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    const rename = f.calls.find((c) => c[0] === "terminal" && c[1] === "rename");
    expect(rename).toBeDefined();
    expect(rename).toContain("term_new");
    expect(rename).toContain("websites--maestro");
  });

  test("never steals focus: no --focus or --activate on any call", async () => {
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
    });
    await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    const flags = f.calls.flat();
    expect(flags).not.toContain("--focus");
    expect(flags).not.toContain("--activate");
  });

  test("a studio whose repo Orca does not know is skipped, not guessed at", async () => {
    const f = fake({ "worktree list": worktrees(), "repo list": REPOS });
    const outcome = await ensureStudioWorkspace("nosuchrepo--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("failed");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
  });

  test("resolves the repo by git remote, not by Orca's display name", async () => {
    // Orca calls it "acme"; the studio id's repo segment is "acme-os" (the
    // git remote's own short name, which is what src/studio/repo.ts derives).
    // Matching on display name alone would skip every acme studio.
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
    });
    await ensureStudioWorkspace("acme-os--maestro", TEST_TITLE, f.deps);
    const create = f.calls.find((c) => c[0] === "worktree" && c[1] === "create");
    expect(create).toContain("id:repo-acme");
  });


});


describe("fleet tabs — the reconcile verb", () => {
  // ---------------------------------------------------------------------------
  // fleet tabs — the reconcile verb.


  test("fleet tabs skips stopped studios", async () => {
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
    });
    const report = await reconcileStudioWorkspaces(
      [studio("websites--maestro", "running"), studio("websites--scratch", "stopped")],
      () => TEST_TITLE,
      f.deps,
    );
    expect(report.opened).toEqual(["websites--maestro"]);
    expect(report.skipped.map((s) => s.id)).toContain("websites--scratch");
    const created = f.calls.filter((c) => c[0] === "worktree" && c[1] === "create");
    expect(created.length).toBe(1);
  });

  test("fleet tabs opens nothing for a fleet that is entirely stopped", async () => {
    const f = fake({ "worktree list": worktrees(), "repo list": REPOS });
    const report = await reconcileStudioWorkspaces([studio("websites--scratch", "stopped")], () => TEST_TITLE, f.deps);
    expect(report.opened).toEqual([]);
    expect(f.calls).toEqual([]);
  });


});


describe("#216 — preview/plan", () => {
  // ---------------------------------------------------------------------------
  // Issue #216: the printed plan `fleet tabs` shows BEFORE acting — one
  // read-only "does this studio already have a workspace?" check reused from
  // `ensureStudioWorkspace`'s own internals (the `worktree list` + lookup it
  // already does before ever creating anything), never a second way to answer
  // that question that could disagree with the real one.

  test("previewStudioWorkspace reads \"open (no worktree)\" for a studio with no worktree yet — worktree list only, no terminal/create calls", async () => {
    const f = fake({ "worktree list": worktrees("staging", "cto") });
    const preview = await previewStudioWorkspace("websites--maestro", f.deps);
    expect(preview).toEqual({ kind: "open", detail: "no worktree" });
    expect(f.calls).toEqual([["worktree", "list", "--json"]]);
  });

  test("previewStudioWorkspace reads \"has one\" only for a worktree whose attach terminal is healthy — worktree list + terminal list, still no create/close calls", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminals(true),
    });
    const preview = await previewStudioWorkspace("websites--maestro", f.deps);
    expect(preview).toEqual({ kind: "has one" });
    expect(f.calls).toEqual([
      ["worktree", "list", "--json"],
      ["terminal", "list", "--worktree", "id:repo-websites::/w/studio-websites--maestro", "--json"],
    ]);
  });

  // #1225: the worktree alone proves nothing — an Orca restart can leave the
  // worktree while its attach terminal is gone, and the plan must then say so
  // rather than print a "has one" that contradicts `fleet ls` ROW's "NO attach".
  test("#1225: a worktree with an empty terminal list previews \"open (no attach)\"", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminals(),
    });
    const preview = await previewStudioWorkspace("websites--maestro", f.deps);
    expect(preview).toEqual({ kind: "open", detail: "no attach" });
  });

  test("#1225: a worktree whose only attach terminal is dead previews \"open (attach DEAD)\"", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_dead", title: "fleet", connected: true, orphaned: true }),
    });
    const preview = await previewStudioWorkspace("websites--maestro", f.deps);
    expect(preview).toEqual({ kind: "open", detail: "attach DEAD" });
  });

  test("previewStudioWorkspace is skipped outside Orca, with zero calls", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    const preview = await previewStudioWorkspace("websites--maestro", f.deps);
    expect(preview).toEqual({ kind: "skipped", why: "not running under Orca" });
    expect(f.calls).toEqual([]);
  });

  test("planStudioWorkspaces skips a stopped studio with ZERO orca calls, same as reconcileStudioWorkspaces", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminals(true),
    });
    const plan = await planStudioWorkspaces(
      [studio("websites--maestro", "running"), studio("websites--scratch", "stopped")],
      f.deps,
    );
    expect(plan).toEqual([
      { id: "websites--maestro", kind: "has one" },
      { id: "websites--scratch", kind: "skipped", why: "stopped" },
    ]);
    // Only the one live studio's read-only lookups ran — worktree list, then
    // terminal list for its healthy attach.
    expect(f.calls).toEqual([
      ["worktree", "list", "--json"],
      ["terminal", "list", "--worktree", "id:repo-websites::/w/studio-websites--maestro", "--json"],
    ]);
  });

  test("the printed plan matches the real reconcile outcome, studio by studio", async () => {
    const studios = [
      studio("websites--maestro", "running"), // no worktree yet -> plan "open", real "opened"
      studio("websites--web-studio", "running"), // worktree + healthy attach -> plan "has one", real "existing"
      studio("websites--scratch", "stopped"), // -> plan + real "skipped: stopped"
    ];
    // Both studios' worktrees share ONE `worktree list`/`terminal list` answer
    // here (matched on the first two argv words only, the same fixture style
    // every other test in this file already uses) — `websites--web-studio`'s
    // worktree is already listed, and its terminal answer is a healthy,
    // connected `fleet` attach, so it reads "has one"/"exists"; `websites
    // --maestro` has no listed worktree at all, so it reads "open"/"opened".
    const f = fake({
      "worktree list": worktrees("studio-websites--web-studio"),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(true),
    });

    const plan = await planStudioWorkspaces(studios, f.deps);
    const report = await reconcileStudioWorkspaces(studios, () => TEST_TITLE, f.deps);

    const planKind = new Map(plan.map((p) => [p.id, p.kind]));
    expect(planKind.get("websites--maestro")).toBe("open");
    expect(planKind.get("websites--web-studio")).toBe("has one");
    expect(planKind.get("websites--scratch")).toBe("skipped");

    expect(report.opened).toContain("websites--maestro");
    expect(report.existing).toContain("websites--web-studio");
    expect(report.skipped.map((s) => s.id)).toContain("websites--scratch");

    // The equivalence the issue's own test list requires: plan "open" ids are
    // exactly report.opened, plan "has one" ids are exactly report.existing,
    // plan "skipped" ids are exactly report.skipped's ids.
    const planOpen = plan.filter((p) => p.kind === "open").map((p) => p.id).sort();
    const planHasOne = plan.filter((p) => p.kind === "has one").map((p) => p.id).sort();
    const planSkipped = plan.filter((p) => p.kind === "skipped").map((p) => p.id).sort();
    expect(planOpen).toEqual([...report.opened].sort());
    expect(planHasOne).toEqual([...report.existing].sort());
    expect(planSkipped).toEqual(report.skipped.map((s) => s.id).sort());
  });


});


describe("process-level exit code + dotted repo", () => {
  // ---------------------------------------------------------------------------
  // Requirement 1, proved at the process level: a caller that would have exited
  // 0 still exits 0 when Orca is broken. Real spawn, real fs — the assertion is
  // the exit CODE, which no in-process test can make.

  test("a broken orca never changes its caller's exit code", () => {
    const script = join(import.meta.dir, "orca-workspace.exit-code.ts");
    const proc = Bun.spawnSync(["bun", script]);
    expect(proc.exitCode).toBe(0);
  });

  // Board #21. A dotted repo's studio id carries the FOLDED segment
  // (`exampleorg-com`), while Orca knows the repo by its real name
  // (`exampleorg.com`, both as displayName and as the tail of its
  // canonicalKey). Without folding on this side too, every dotted repo's studio
  // throws "Orca knows no repo" and gets NO sidebar row — the exact
  // invisible-agent failure ensureStudioWorkspace exists to prevent.
  test("resolves a dotted repo from the studio id's folded segment", async () => {
    const f = fake({
      "worktree list": worktrees("staging"),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
    });

    const outcome = await ensureStudioWorkspace("exampleorg-com--maestro", TEST_TITLE, f.deps);

    expect(outcome.kind).toBe("created");
    const create = f.calls.find((c) => c[0] === "worktree" && c[1] === "create");
    expect(create).toContain("id:repo-tsh");
    expect(create).toContain("studio-exampleorg-com--maestro");
  });


});
