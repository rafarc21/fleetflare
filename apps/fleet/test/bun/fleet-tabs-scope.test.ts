// Issue #216: `fleet tabs` had no repo filter at all — it reconciled EVERY
// studio in the fleet, including other repos' and other operators' studios,
// stacking duplicate attach clients on rows nobody asked to touch. This suite
// covers the fix's testable core, `runTabs` (cli/fleet.ts): cwd-default repo
// scope, explicit --repo, --all (today's old behaviour, now opt-in), the
// no-repo refusal, the printed-plan-matches-the-actions equivalence, and the
// --all confirmation gate.
//
// bun:test lane (CLI code, same reason orca-workspace.test.ts's own header
// gives). Every Orca call is injected through a fake `OrcaDeps` — never real
// Orca, per issue #210's own mid-fix warning against exactly that.
import { test, expect } from "bun:test";
import {
  runTabs,
  type TabsFlags,
  type TabsDeps,
} from "../../cli/fleet";
import type { OrcaDeps, OrcaResult } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";
import type { BoardTask } from "../../src/board/types";
import type { DetectedRepo } from "../../cli/fleet";

// ---------------------------------------------------------------------------
// Fakes — same shape as orca-workspace.test.ts's own `fake()` (matched on the
// first two argv words), duplicated here rather than imported: that helper
// is not exported, and this file's fixtures are deliberately smaller (no
// duplicate-terminal ranking, no salvage, none of that suite's other concerns).

const ORCA_ENV = { TERM_PROGRAM: "Orca" } as Record<string, string | undefined>;

function ok(stdout: string): OrcaResult {
  return { ok: true, stdout, stderr: "", timedOut: false };
}

function studio(id: string, state: StudioStatus["state"] = "running"): StudioStatus {
  return { id, state } as StudioStatus;
}

interface FakeOrca {
  deps: OrcaDeps;
  calls: string[][];
}

function fakeOrca(answers: Record<string, OrcaResult> = {}): FakeOrca {
  const calls: string[][] = [];
  const memory = new Map<string, string>();
  const deps: OrcaDeps = {
    env: ORCA_ENV,
    hasBinary: () => "orca",
    registry: { get: (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); } },
    log: () => {},
    run: async (args) => {
      calls.push(args);
      const a = answers[`${args[0]} ${args[1]}`];
      return a ?? ok("{}");
    },
    lock: async (_id, fn) => fn(),
  };
  return { deps, calls };
}

function worktrees(...displayNames: string[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: {
      worktrees: displayNames.map((displayName) => ({
        id: `repo-x::/w/${displayName}`, displayName, path: `/fake/orca/${displayName}`,
      })),
    },
  }));
}

const REPOS = ok(JSON.stringify({
  ok: true,
  result: { repos: [{ id: "repo-websites", displayName: "websites" }] },
}));

const CREATED = ok(JSON.stringify({
  ok: true,
  result: { worktree: { id: "repo-websites::/w/studio-websites--pilot", displayName: "studio-websites--pilot" } },
}));

const TERM_CREATED = ok(JSON.stringify({
  ok: true,
  result: { terminal: { handle: "term_new", title: "fleet" } },
}));

function terminals(...connected: boolean[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: { terminals: connected.map((c, i) => ({ handle: `term_${i}`, title: "fleet", connected: c })) },
  }));
}

/** A `runTabs` deps bag with sane, overridable defaults. `detectRepo`,
 *  `listStudios` and `confirm` are spied (call counts recorded) so the
 *  "never called" assertions below (explicit --repo skips detectRepo; a
 *  no-repo refusal never lists studios; --yes never prompts) have something
 *  to check. */
function fakeDeps(over: {
  detectRepo?: () => Promise<DetectedRepo>;
  studios?: StudioStatus[];
  orca?: FakeOrca;
  confirmAnswer?: boolean;
} = {}): { deps: TabsDeps; orca: FakeOrca; detectRepoCalls: number[]; listStudiosCalls: number[]; confirmCalls: string[] } {
  const orca = over.orca ?? fakeOrca();
  const detectRepoCalls: number[] = [];
  const listStudiosCalls: number[] = [];
  const confirmCalls: string[] = [];
  const deps: TabsDeps = {
    detectRepo: async () => {
      detectRepoCalls.push(1);
      return over.detectRepo ? over.detectRepo() : { slug: null, reason: "not called" };
    },
    listStudios: async () => {
      listStudiosCalls.push(1);
      return over.studios ?? [];
    },
    listStudioTasks: async (): Promise<BoardTask[]> => [],
    orcaDeps: orca.deps,
    confirm: async (question: string) => {
      confirmCalls.push(question);
      return over.confirmAnswer ?? false;
    },
    log: () => {},
  };
  return { deps, orca, detectRepoCalls, listStudiosCalls, confirmCalls };
}

function flags(over: Partial<TabsFlags> = {}): TabsFlags {
  return { repo: null, all: false, yes: false, ...over };
}

// ---------------------------------------------------------------------------
// cwd repo scope (default).

test("cwd repo scope: only that repo's studios appear in the plan and get touched", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees("studio-websites--maestro"),
    "repo list": REPOS,
    "worktree create": CREATED,
    "terminal list": terminals(true),
    "terminal create": TERM_CREATED,
  });
  const { deps, listStudiosCalls } = fakeDeps({
    detectRepo: async () => ({ slug: "some-org/websites", reason: null }),
    studios: [
      studio("websites--maestro"),
      studio("websites--pilot"),
      studio("acme-os--maestro"),
    ],
    orca,
  });

  const result = await runTabs(flags(), deps);
  expect(listStudiosCalls.length).toBe(1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");

  const planIds = result.plan.map((p) => p.id).sort();
  expect(planIds).toEqual(["websites--maestro", "websites--pilot"]);
  expect(result.studios.map((s) => s.id).sort()).toEqual(["websites--maestro", "websites--pilot"]);

  if (result.cancelled) throw new Error("should not be cancelled — repo-scoped run never confirms");
  expect([...result.report.opened, ...result.report.existing].sort()).toEqual(["websites--maestro", "websites--pilot"]);

  // The other repo's studio was never named in any Orca call at all —
  // `worktree list` runs TWICE per in-scope studio (once for the plan
  // preview, once again inside the real `ensure()` — deliberately not
  // cached, see `previewStudioWorkspace`'s own doc comment), so exactly 4
  // calls total for the two in-scope studios, never a 5th/6th pair for
  // acme-os--maestro.
  const worktreeListCalls = orca.calls.filter((c) => c[0] === "worktree" && c[1] === "list");
  expect(worktreeListCalls.length).toBe(4);
  expect(orca.calls.some((c) => c.some((tok) => tok.includes("acme")))).toBe(false);
});

// ---------------------------------------------------------------------------
// --all: explicit, fleet-wide, kept as today's old behaviour.

test("--all touches every repo's studios, explicitly requested", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees("studio-websites--maestro", "studio-acme-os--maestro"),
    "terminal list": terminals(true),
  });
  const { deps, confirmCalls } = fakeDeps({
    studios: [studio("websites--maestro"), studio("acme-os--maestro")],
    orca,
  });

  const result = await runTabs(flags({ all: true, yes: true }), deps);
  expect(result.ok).toBe(true);
  if (!result.ok || result.cancelled) throw new Error("unreachable");
  expect(confirmCalls.length).toBe(0); // --yes skips the prompt entirely
  expect([...result.report.existing].sort()).toEqual(["acme-os--maestro", "websites--maestro"]);
  expect(result.plan.map((p) => p.id).sort()).toEqual(["acme-os--maestro", "websites--maestro"]);
});

// ---------------------------------------------------------------------------
// cwd names no repo: refuse, never fall back to --all.

test("cwd names no repo: refuses cleanly and touches nothing", async () => {
  const { deps, listStudiosCalls } = fakeDeps({
    detectRepo: async () => ({ slug: null, reason: "fatal: not a git repository" }),
  });

  const result = await runTabs(flags(), deps);
  expect(result.ok).toBe(false);
  expect(listStudiosCalls.length).toBe(0); // never even asked the fleet for its studio list
  if (result.ok) throw new Error("unreachable");
  expect(result.message).toMatch(/not a git repository/);
  expect(result.message).not.toMatch(/every repo|fleet-wide/i);
});

// ---------------------------------------------------------------------------
// The printed plan matches the actions.

test("the printed plan matches the actions, studio by studio", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees("studio-websites--maestro"),
    "repo list": REPOS,
    "worktree create": CREATED,
    "terminal list": terminals(true),
    "terminal create": TERM_CREATED,
  });
  const { deps } = fakeDeps({
    detectRepo: async () => ({ slug: "some-org/websites", reason: null }),
    studios: [studio("websites--maestro"), studio("websites--pilot"), studio("websites--scratch", "stopped")],
    orca,
  });

  const result = await runTabs(flags(), deps);
  expect(result.ok).toBe(true);
  if (!result.ok || result.cancelled) throw new Error("unreachable");

  const planKind = new Map(result.plan.map((p) => [p.id, p.kind]));
  expect(planKind.get("websites--maestro")).toBe("has one");
  expect(planKind.get("websites--pilot")).toBe("open");
  expect(planKind.get("websites--scratch")).toBe("skipped");

  const planOpen = result.plan.filter((p) => p.kind === "open").map((p) => p.id).sort();
  const planHasOne = result.plan.filter((p) => p.kind === "has one").map((p) => p.id).sort();
  const planSkipped = result.plan.filter((p) => p.kind === "skipped").map((p) => p.id).sort();
  expect(planOpen).toEqual([...result.report.opened].sort());
  expect(planHasOne).toEqual([...result.report.existing].sort());
  expect(planSkipped).toEqual(result.report.skipped.map((s) => s.id).sort());
});

// ---------------------------------------------------------------------------
// Confirmation gate — fleet-wide only.

test("--all without --yes prompts, and a non-affirmative answer cancels with nothing touched", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees(),
    "repo list": REPOS,
    "worktree create": CREATED,
    "terminal create": TERM_CREATED,
  });
  const { deps, confirmCalls } = fakeDeps({
    studios: [studio("websites--maestro")],
    orca,
    confirmAnswer: false,
  });

  const result = await runTabs(flags({ all: true, yes: false }), deps);
  expect(confirmCalls.length).toBe(1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.cancelled).toBe(true);

  // Nothing MUTATING happened — the plan's own read-only `worktree list` is
  // the only call this run ever made; reconcile (create/close/set/rename)
  // never ran at all.
  const mutating = orca.calls.filter((c) => ["create", "close", "set", "rename"].includes(c[1]));
  expect(mutating).toEqual([]);
});

test("--all with an explicit \"no\" answer is cancelled the same way", async () => {
  const orca = fakeOrca({ "worktree list": worktrees() });
  const { deps, confirmCalls } = fakeDeps({
    studios: [studio("websites--maestro")],
    orca,
    confirmAnswer: false,
  });
  confirmCalls.length = 0;
  const result = await runTabs(flags({ all: true }), deps);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.cancelled).toBe(true);
  const mutating = orca.calls.filter((c) => ["create", "close", "set", "rename"].includes(c[1]));
  expect(mutating).toEqual([]);
});

test("--all --yes never prompts and proceeds straight through", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees(),
    "repo list": REPOS,
    "worktree create": CREATED,
    "terminal list": terminals(),
    "terminal create": TERM_CREATED,
  });
  const { deps, confirmCalls } = fakeDeps({ studios: [studio("websites--maestro")], orca, confirmAnswer: false });

  const result = await runTabs(flags({ all: true, yes: true }), deps);
  expect(confirmCalls.length).toBe(0);
  expect(result.ok).toBe(true);
  if (!result.ok || result.cancelled) throw new Error("should have proceeded — --yes skips confirmation");
  expect(result.report.opened).toEqual(["websites--maestro"]);
});

// ---------------------------------------------------------------------------
// --repo <slug>: explicit override, ignores the actual cwd/detectRepo result.

test("--repo <slug> behaves like cwd-scope but for the given slug, ignoring detectRepo entirely", async () => {
  const orca = fakeOrca({
    "worktree list": worktrees("studio-websites--maestro"),
    "terminal list": terminals(true),
  });
  const { deps, detectRepoCalls } = fakeDeps({
    detectRepo: async () => ({ slug: "some-org/acme-os", reason: null }), // must be IGNORED
    studios: [studio("websites--maestro"), studio("acme-os--maestro")],
    orca,
  });

  const result = await runTabs(flags({ repo: "another-org/websites" }), deps);
  expect(detectRepoCalls.length).toBe(0); // --repo skips detectRepo entirely
  expect(result.ok).toBe(true);
  if (!result.ok || result.cancelled) throw new Error("unreachable");
  expect(result.studios.map((s) => s.id)).toEqual(["websites--maestro"]);
  expect(result.report.existing).toEqual(["websites--maestro"]);
});

test("--repo naming an invalid segment refuses, same posture as a no-repo cwd", async () => {
  const { deps, listStudiosCalls } = fakeDeps({});
  const result = await runTabs(flags({ repo: "acme/-" }), deps);
  expect(result.ok).toBe(false);
  expect(listStudiosCalls.length).toBe(0);
});
