// `removeStudioWorkspace` + the workspace registry — the REGISTRY half of the
// old orca-workspace.test.ts (split per plan
// docs/superpowers/plans/2026-10-13-orca-split-693.md, issue #693): teardown
// and its printed lines, lost-entry healing, the real file-backed registry
// and lock, row titles, the `fleet ls` ROW column, ranking, partial answers,
// the openStudioRow/closeStudioRow pairs, and findAttachHandle. The
// ensure-core half (name derivation, presence, ensureStudioWorkspace's five
// hard requirements) lives in orca-ensure-verbs.test.ts; the verbs/reconcile
// half (duplicate-terminal reconciliation, the tabs/plan verbs, the
// exit-code process test) in orca-ensure-reconcile.test.ts.
//
// bun:test lane, not the workerd lane: this is CLI code (Bun.which, Bun.spawn,
// process env), and vitest-pool-workers cannot host any of it. Every orca
// invocation is INJECTED, so no test here ever shells out to real Orca — the
// tests that do spawn processes (the 8-process registry race, the registry
// writer scripts) write real files under temp dirs only.
import { test, describe, expect, mock, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import {
  studioWorkspaceName,
  studioWorkspaceTitle,
  type WorkspaceRegistry,
  ensureStudioWorkspace,
  openStudioRow,
  closeStudioRow,
  reconcileStudioWorkspaces,
  removeStudioWorkspace,
  describeWorkspaceRemoval,
  classifyStudioRow,
  readStudioRows,
  findAttachHandle,
  fileLockAt,
  fileWorkspaceRegistry,
  lockFileName,
  type OrcaDeps,
  type OrcaResult,
  type ContextSalvageDeps,
  type WorkspaceRemovalOutcome,
} from "../../cli/orca-workspace";
import { attachTitle } from "../../cli/attach-liveness";
import type { BoardTask } from "../../src/board/types";
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
 *  a fixed one — `studioWorkspaceTitle`'s own behaviour is covered separately
 *  below. */
const TEST_TITLE = "websites · #7 some task";

/** A `WorkspaceRegistry` that lives only for one test. Board #39: the real
 *  one is a JSON file under ~/.fleet, and no unit test should touch it. */
function memoryRegistry(): WorkspaceRegistry {
  const m = new Map<string, string>();
  return {
    get: (id) => m.get(id),
    set: async (id, worktreeId) => {
      m.set(id, worktreeId);
    },
  };
}

function boardTask(fields: {
  number: number;
  title: string;
  state: BoardTask["state"];
  assignee: string | null;
  updatedAt?: string;
}): BoardTask {
  return {
    number: fields.number,
    url: `https://github.com/x/x/issues/${fields.number}`,
    title: fields.title,
    body: "",
    state: fields.state,
    labels: [],
    assignee: fields.assignee,
    milestone: null,
    open: true,
    updatedAt: fields.updatedAt ?? "2026-09-23T00:00:00Z",
  };
}

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
 *  its display title (board #39). A test specifically about a row whose
 *  display title has since diverged from its stable path (the exact #175
 *  scenario) uses `worktreesWithPath` below instead, with the two set
 *  independently. */
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

/** Same shape as `worktrees()` but each entry's `path` is independent of its
 *  `displayName` — the field `removeStudioWorkspace` needs to make the
 *  destructive `worktree rm` call at all (see orca-workspace.ts's own
 *  "UNCONFIRMED" comment on that field), and the shape #175's own tests use
 *  to pin a task-titled display whose PATH still carries the stable name. */
function worktreesWithPath(...entries: { displayName: string; path: string }[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: { worktrees: entries.map((e) => ({ id: `repo-websites::/w/${e.displayName}`, displayName: e.displayName, path: e.path })) },
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

// ---------------------------------------------------------------------------
// removeStudioWorkspace — board issue #57's teardown counterpart. `fleet
// destroy` stopping the container never removed the sidebar row or its dead
// attach terminal; this proves the fix does, and safely.

const FIXED_NOW = () => new Date("2026-09-23T10:00:00.000Z");

/** `basename`, when given, names the returned directory itself (nested
 *  inside a fresh, unique parent, so parallel tests never collide) — #175:
 *  the tests that assert a REMOVAL, given an already-found worktree, need
 *  that basename to equal `studioWorkspaceName(id)` so `findStudioWorktree`'s
 *  path fallback can find it with no registry entry seeded; tests that seed
 *  the registry directly (or test the no-path refusal) don't care and omit
 *  it. */
function tmpWorktree(files: Record<string, string> = {}, basename?: string): string {
  const parent = mkdtempSync(join(tmpdir(), "fleet-teardown-wt-"));
  const dir = basename ? join(parent, basename) : parent;
  if (basename) mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function tmpSalvageRoot(): ContextSalvageDeps {
  return { root: mkdtempSync(join(tmpdir(), "fleet-teardown-salvage-")), now: FIXED_NOW };
}

describe("removeStudioWorkspace — teardown", () => {
  test("removeStudioWorkspace makes no orca call at all outside Orca", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(f.calls).toEqual([]);
    expect(outcome.kind).toBe("skipped");
  });

  test("removeStudioWorkspace is a no-op when the studio has no Orca worktree", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--pilot"),
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [] } })),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("absent");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "close")).toBe(false);
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "rm")).toBe(false);
  });

  test("removeStudioWorkspace closes every connected terminal, then removes the worktree by path", async () => {
    const wt = tmpWorktree({}, "studio-websites--maestro");
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "studio-websites--maestro", path: wt }),
      "terminal list": terminals(true, false, true), // term_0 and term_2 connected, term_1 not
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());

    expect(outcome.kind).toBe("removed");
    const closes = f.calls.filter((c) => c[0] === "terminal" && c[1] === "close");
    expect(closes.map((c) => c[c.indexOf("--terminal") + 1])).toEqual(["term_0", "term_2"]);

    const rm = f.calls.find((c) => c[0] === "worktree" && c[1] === "rm");
    expect(rm).toBeDefined();
    expect(rm).toContain(`path:${wt}`);

    // Ordering: every close happens before the removal.
    const rmIndex = f.calls.indexOf(rm!);
    for (const close of closes) expect(f.calls.indexOf(close)).toBeLessThan(rmIndex);
  });

  test("removeStudioWorkspace refuses removal when Orca reports no path for the worktree", async () => {
    // #175: the registry (not the now-dead displayName fallback) is what finds
    // this row — its id matches, but its path is still missing, and the
    // path-basename fallback below it in findStudioWorktree cannot rescue a
    // row that HAS no path to match on anyway.
    const registry = memoryRegistry();
    await registry.set("websites--maestro", "repo-websites::/w/studio-websites--maestro");
    const f = fake({
      "worktree list": ok(JSON.stringify({
        ok: true,
        result: { worktrees: [{ id: "repo-websites::/w/studio-websites--maestro", displayName: "studio-websites--maestro" }] },
      })), // no `path` field, unlike worktrees()'s own default (#175)
      "terminal list": terminals(),
    }, { registry });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.why).toContain("no reported path");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "rm")).toBe(false);
  });

  test("removeStudioWorkspace, no registry entry and no path either: the row is unfindable — falls through to the terminal sweep, not a false refusal", async () => {
    const f = fake({
      "worktree list": ok(JSON.stringify({
        ok: true,
        result: { worktrees: [{ id: "repo-websites::/w/studio-websites--maestro", displayName: "studio-websites--maestro" }] },
      })),
      "terminal list": terminals(),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("absent");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "rm")).toBe(false);
  });

  test("removeStudioWorkspace never constructs a name: selector for the destructive worktree rm call", async () => {
    const wt = tmpWorktree({}, "studio-websites--maestro");
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "studio-websites--maestro", path: wt }),
      "terminal list": terminals(),
    });
    await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    const rmCalls = f.calls.filter((c) => c[0] === "worktree" && c[1] === "rm");
    expect(rmCalls.length).toBeGreaterThan(0);
    for (const call of rmCalls) {
      expect(call.some((a) => a.startsWith("name:"))).toBe(false);
      expect(call.some((a) => a.startsWith("path:"))).toBe(true);
    }
  });

  test("removeStudioWorkspace salvages a populated .context/ before removing the worktree", async () => {
    const wt = tmpWorktree({ ".context/shot.png": "PNGDATA", ".context/notes/a.md": "note" }, "studio-websites--maestro");
    const salvageDest = tmpSalvageRoot();
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "studio-websites--maestro", path: wt }),
      "terminal list": terminals(),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, salvageDest);
    expect(outcome.kind).toBe("removed");
    if (outcome.kind !== "removed") throw new Error("unreachable");
    expect(outcome.salvage.kind).toBe("salvaged");
    if (outcome.salvage.kind !== "salvaged") throw new Error("unreachable");
    expect(outcome.salvage.inventory).toEqual({ screenshotCount: 1, contextFileCount: 1, totalCount: 2 });
    expect(readFileSync(join(outcome.salvage.destination, "shot.png"), "utf8")).toBe("PNGDATA");
    // The worktree rm call only happens AFTER the salvage completed.
    const rm = f.calls.find((c) => c[0] === "worktree" && c[1] === "rm");
    expect(rm).toBeDefined();
  });

  test("removeStudioWorkspace refuses removal when context salvage itself fails, and makes no rm call", async () => {
    const wt = tmpWorktree({ ".context/shot.png": "x" }, "studio-websites--maestro");
    const parent = mkdtempSync(join(tmpdir(), "fleet-teardown-salvage-parent-"));
    const notADir = join(parent, "not-a-directory");
    writeFileSync(notADir, "not a directory");
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "studio-websites--maestro", path: wt }),
      "terminal list": terminals(),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, { root: notADir, now: FIXED_NOW });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.why).toContain("salvage of .context/ failed");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "rm")).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  test("removeStudioWorkspace fails soft on a timed-out orca call: no throw, and logging is the caller's job", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "", timedOut: true } });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    // #124 item 7: a failed LOOKUP is "could not verify", never "failed" or
    // "complete" — absence is unproven.
    expect(outcome.kind).toBe("unverified");
    if (outcome.kind !== "unverified") throw new Error("unreachable");
    // removeStudioWorkspace itself logs nothing — cmdDestroy's single
    // describeWorkspaceRemoval() call is the one place this failure gets
    // printed, so the operator sees it exactly once, not twice.
    expect(f.lines.length).toBe(0);
    const lines = describeWorkspaceRemoval("websites--maestro", outcome);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("timed out");
  });

  test("describeWorkspaceRemoval: skipped prints nothing", () => {
    expect(describeWorkspaceRemoval("websites--maestro", { kind: "skipped", why: "not running under Orca" })).toEqual([]);
  });

  test("describeWorkspaceRemoval: removed with a salvage names the destination", () => {
    const outcome: WorkspaceRemovalOutcome = {
      kind: "removed",
      salvage: { kind: "salvaged", destination: "/home/x/fleet-teardown-salvage/websites--maestro-1", inventory: { screenshotCount: 2, contextFileCount: 3, totalCount: 5 } },
    };
    const lines = describeWorkspaceRemoval("websites--maestro", outcome);
    expect(lines[0]).toContain("removed");
    expect(lines.some((l) => l.includes("/home/x/fleet-teardown-salvage/websites--maestro-1"))).toBe(true);
    expect(lines.some((l) => l.includes("2 screenshot"))).toBe(true);
  });

  test("describeWorkspaceRemoval: refused names the reason", () => {
    const lines = describeWorkspaceRemoval("websites--maestro", { kind: "refused", why: "has 11 screenshot(s) + 24 context file(s)" });
    expect(lines[0]).toContain("NOT removed");
    expect(lines[0]).toContain("11 screenshot(s) + 24 context file(s)");
  });
});


// ---------------------------------------------------------------------------
// Board #175: a lost registry entry must still find its row by a STABLE key
// — the worktree's PATH — never by the row's mutable display title. Measured
// 2026-09-24: `~/.fleet/orca-workspaces.json` lost `fleetflare--scratch`'s
// entry between two `fleet` processes; the OLD fallback
// (`displayName === studioWorkspaceName(id)`) could never have matched
// anyway, because board #39 stamps every row's display title with the
// studio's CURRENT TASK on every single `ensure()` call — so `fleet tabs`
// believed the studio had no worktree at all and created a second one.

describe("#175 — lost-entry healing by PATH", () => {
  test("#175: a lost registry entry is found by its worktree's PATH, healed, and creates nothing", async () => {
    const wtId = "repo-fleetflare::/w/fleetflare-scratch";
    const f = fake({
      "worktree list": ok(JSON.stringify({
        ok: true,
        result: { worktrees: [{
          id: wtId,
          displayName: "fleetflare · #157 some in-flight task", // #39's stamp — NOT studio-<id>
          path: "/Users/you/orca/fleetflare/studio-fleetflare-scratch",
        }] },
      })),
      "terminal list": terminals(true),
    }); // empty registry — the exact "lost entry" shape
    const outcome = await ensureStudioWorkspace("fleetflare--scratch", TEST_TITLE, f.deps);

    expect(outcome.kind).toBe("exists");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    // Healed: the registry now records it, so the NEXT call finds it without
    // the fallback at all.
    expect(f.deps.registry.get("fleetflare--scratch")).toBe(wtId);
  });

  test("#175: readStudioRows (fleet ls's ROW) finds the same lost-entry row, not '-'", async () => {
    const f = fake({
      "worktree list": worktreesWithPath({
        displayName: "fleetflare · #157 some in-flight task",
        path: "/Users/you/orca/fleetflare/studio-fleetflare-scratch",
      }),
      // The healthy attach lives in THAT row (worktreeId), so the column reads
      // `ok` -- not merely "something other than NO row".
      "terminal list": terminalEntries({
        handle: "term_0", title: "fleet", connected: true,
        worktreeId: "repo-websites::/w/fleetflare · #157 some in-flight task",
      }),
    });
    const rows = await readStudioRows(
      [{ id: "fleetflare--scratch", state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null }],
      f.deps,
    );
    expect(rows.rows.get("fleetflare--scratch")).toBe("ok");
  });

  test("#175 fix round: a lost registry entry is found via the FOLDED path Orca actually uses on disk (hyphen runs collapsed)", async () => {
    // MEASURED 2026-09-24 (removeStudioWorkspace's own studioFolderNames):
    // studio `fleetflare--web-studio` lives at
    // `.../studio-fleetflare-web-studio`, NOT `.../studio-fleetflare--web-studio`
    // — the VERBATIM name this code itself passes to `worktree create --name`.
    // A fallback that checks only the verbatim form can never match a REAL
    // row; this is the shape that actually occurs in production.
    const wtId = "repo-fleetflare::/w/fleetflare-web-studio";
    const f = fake({
      "worktree list": ok(JSON.stringify({
        ok: true,
        result: { worktrees: [{
          id: wtId,
          displayName: "fleetflare · #200 another task",
          path: "/Users/you/orca/fleetflare/studio-fleetflare-web-studio", // FOLDED, single hyphen
        }] },
      })),
      "terminal list": terminals(true),
    });
    const outcome = await ensureStudioWorkspace("fleetflare--web-studio", TEST_TITLE, f.deps);

    expect(outcome.kind).toBe("exists");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    expect(f.deps.registry.get("fleetflare--web-studio")).toBe(wtId);
  });

  test("#175: a lost registry entry with a MISMATCHED path is genuinely not found — creates one, proving the fallback is not accidentally lenient", async () => {
    const f = fake({
      "worktree list": worktreesWithPath({
        displayName: "fleetflare · #157 some in-flight task",
        path: "/Users/you/orca/fleetflare/studio-SOME-OTHER-STUDIO",
      }),
      "repo list": ok(JSON.stringify({
        ok: true, result: { repos: [{ id: "repo-fleetflare", displayName: "fleetflare", gitRemoteIdentity: { canonicalKey: "github.com/rafarc21/fleetflare" } }] },
      })),
      "worktree create": CREATED,
      "terminal list": terminals(),
    });
    const outcome = await ensureStudioWorkspace("fleetflare--scratch", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
  });
});


// ---------------------------------------------------------------------------
// #193: the path fallback matches the folder basename EXACTLY. This lookup
// feeds teardown's destructive `worktree rm --worktree path:` — a looser match
// (startsWith, substring) would let destroying `websites--web` remove
// `websites--web-studio`'s worktree, or heal onto Orca's `-2` duplicate
// instead of the original. Folder names below are the shape real Orca
// produces: `--` folded to `-`, and `-2` appended to a clashing name.

const WEB = "websites--web";

/** Worktree rows at `/Users/you/orca/websites/<folder>`, each carrying a
 *  #39 task title (never the stable name) and an id derived from the folder. */
function folderRows(...folders: string[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: {
      worktrees: folders.map((folder) => ({
        id: `wt:${folder}`,
        displayName: "websites · #9 a task title",
        path: `/Users/you/orca/websites/${folder}`,
      })),
    },
  }));
}

function runningStudio(id: string): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null };
}

describe("#193 — exact-path fallback", () => {
  test("#193: Orca's `-2` duplicate alone never matches the studio", async () => {
    const f = fake({ "worktree list": folderRows("studio-websites-web-2"), "terminal list": terminals(true) });
    const rows = await readStudioRows([runningStudio(WEB)], f.deps);
    expect(rows.rows.get(WEB)).toBe("NO row");
  });

  for (const order of [["studio-websites-web", "studio-websites-web-2"], ["studio-websites-web-2", "studio-websites-web"]]) {
    test(`#193: original + \`-2\` listed [${order.join(", ")}] — a lost entry heals to the ORIGINAL`, async () => {
      const f = fake({ "worktree list": folderRows(...order), "terminal list": terminals(true) });
      const outcome = await ensureStudioWorkspace(WEB, TEST_TITLE, f.deps);
      expect(outcome.kind).toBe("exists");
      expect(f.deps.registry.get(WEB)).toBe("wt:studio-websites-web");
      expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    });
  }

  test("#193: `studio-websites-web-studio` never matches studio `websites--web`", async () => {
    const f = fake({ "worktree list": folderRows("studio-websites-web-studio"), "terminal list": terminals(true) });
    const rows = await readStudioRows([runningStudio(WEB)], f.deps);
    expect(rows.rows.get(WEB)).toBe("NO row");
  });

  test("#193: destroying `websites--web` with only `websites--web-studio`'s worktree listed removes NOTHING", async () => {
    // A real folder with no .context/, so a wrong match would salvage cleanly
    // and go on to the `worktree rm` — the call this test proves never happens.
    const wt = tmpWorktree({}, "studio-websites-web-studio");
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "websites · #9 a task title", path: wt }),
      "terminal list": terminalEntries({ handle: "term_web_studio", title: "fleet", connected: true, worktreePath: wt }),
    });
    const outcome = await removeStudioWorkspace(WEB, f.deps, tmpSalvageRoot());

    expect(f.calls.filter((c) => c[0] === "worktree" && c[1] === "rm")).toEqual([]);
    expect(f.calls.filter((c) => c[0] === "terminal" && c[1] === "close")).toEqual([]);
    expect(outcome).toEqual({ kind: "absent", closedAttach: [], survivingPaths: [] });
  });
});


// ---------------------------------------------------------------------------
// #297: multi-instance studio `<repo>--<role>--<n>` (#269/#275). Orca folds
// `studio-demosite-life--web-studio--2` to folder
// `studio-demosite-life-web-studio-2` and titles the row `web-studio#2`
// (MEASURED 2026-09-25). The fleet id `--2` never appears in Orca naming, so
// the ROW lookup must map id ↔ folded folder, and must not confuse instance 2
// with instance 1 (`studio-demosite-life-web-studio`, one suffix shorter).

const INST1 = "demosite-life--web-studio";
const INST2 = "demosite-life--web-studio--2";
const INST_ROWS = folderRows("studio-demosite-life-web-studio", "studio-demosite-life-web-studio-2");
const instAttach = (id: string, folder: string, handle: string) => ({
  handle, title: attachTitle(id, "live"), connected: true, worktreeId: `wt:${folder}`,
});

describe("#297 — multi-instance studios", () => {
  test("#297: ROW for a live instance studio `<repo>--<role>--<n>` reads `ok` via its folded folder, empty registry", async () => {
    const f = fake({
      "worktree list": folderRows("studio-demosite-life-web-studio-2"),
      "terminal list": terminalEntries(instAttach(INST2, "studio-demosite-life-web-studio-2", "term_i2")),
    });
    const rows = await readStudioRows([runningStudio(INST2)], f.deps);
    expect(rows.rows.get(INST2)).toBe("ok");
  });

  test("#297: instance 1 and instance 2 listed together — each ROW judges its OWN folder's attach", async () => {
    // Only instance 2 has an attach terminal. A lookup that crossed the two
    // would flip these verdicts.
    const f = fake({
      "worktree list": INST_ROWS,
      "terminal list": terminalEntries(instAttach(INST2, "studio-demosite-life-web-studio-2", "term_i2")),
    });
    const rows = await readStudioRows([runningStudio(INST1), runningStudio(INST2)], f.deps);
    expect(rows.rows.get(INST2)).toBe("ok");
    expect(rows.rows.get(INST1)).toBe("NO attach");
  });

  test("#297: findAttachHandle for an instance returns ITS handle, never instance 1's", async () => {
    const f = fake({
      "worktree list": INST_ROWS,
      "terminal list": terminalEntries(
        instAttach(INST1, "studio-demosite-life-web-studio", "term_i1"),
        instAttach(INST2, "studio-demosite-life-web-studio-2", "term_i2"),
      ),
    });
    expect(await findAttachHandle(INST2, f.deps)).toBe("term_i2");
    expect(await findAttachHandle(INST1, f.deps)).toBe("term_i1");
  });

  test("#297: a lost registry entry for an instance heals to `studio-<repo>-<role>-<n>` — no duplicate create", async () => {
    const f = fake({ "worktree list": INST_ROWS, "terminal list": terminals(true) });
    const outcome = await ensureStudioWorkspace(INST2, TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("exists");
    expect(f.deps.registry.get(INST2)).toBe("wt:studio-demosite-life-web-studio-2");
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Board #175: the registry's own lost-update race. `fileWorkspaceRegistry`
// (the REAL file-backed implementation `defaultOrcaDeps()` wires, not
// `memoryRegistry`'s in-test stand-in) used to cache its first read for the
// whole process and blind-overwrite the file on every `set` — a plain,
// unlocked read-modify-write. Two `fleet` processes ensuring DIFFERENT
// studios (a 60s `fleet ls` monitor, `ff`, `fleet tabs` — #175's own
// measurement names all three) take DIFFERENT per-studio #42 locks and can
// freely interleave; whichever's write lands second blind-overwrites the
// other's key.

function tmpRegistryFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fleet-registry-")), "orca-workspaces.json");
}

describe("#175 — registry races", () => {
  // #175 fix round: a `Promise.all([registry.set(a), registry.set(b)])` on ONE
  // `registry` object proves nothing about the actual bug — `set`'s first
  // synchronous step (fileLockAt's own `writeFileSync(..., { flag: "wx" })`
  // lock acquire) runs to completion before either call's first `await`, so
  // the SECOND call is already correctly queued behind the lock before the
  // event loop gets a turn; there is no genuine race left to lose. It also
  // never exercised the ACTUAL historical bug (a stale in-process CACHE),
  // which this fix removed entirely — `get`/`set` always read the file fresh.
  // The real claim worth pinning is that fresh: a write started AFTER another
  // process's write has already landed on disk must fold that write in,
  // deterministically, no timing games required.
  test("#175: a write folds in a DIFFERENT key a separate process wrote directly to the file in between — the lost-update race this closes", async () => {
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    const registry = fileWorkspaceRegistry(path, lockDir);

    await registry.set("fleetflare--scratch", "wt-scratch");
    // A DIFFERENT `fleet` process's own write landing in between — never
    // through THIS registry object, exactly like two real OS processes.
    const midway = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    writeFileSync(path, JSON.stringify({ ...midway, "fleetflare--pilot": "wt-pilot" }));

    await registry.set("fleetflare--web-studio", "wt-web");

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({
      "fleetflare--scratch": "wt-scratch", "fleetflare--pilot": "wt-pilot", "fleetflare--web-studio": "wt-web",
    });
  });

  // #175 fix round: `set` is documented ("never a failure of
  // ensureStudioWorkspace itself") to never reject — but `fileLockAt` itself
  // DOES throw (past LOCK_WAIT_MS, or on a synchronous failure acquiring the
  // lock at all), and that throw was not caught. A lock-dir that cannot even
  // be created (a plain FILE sits where the directory needs to go) fails
  // FAST and deterministically — the same failure mode a timeout would
  // eventually produce, without a real test waiting out LOCK_WAIT_MS.
  test("#175: set() never rejects, even when the lock mechanism itself is broken", async () => {
    const parent = mkdtempSync(join(tmpdir(), "fleet-registry-broken-lock-"));
    const brokenLockDir = join(parent, "not-a-directory");
    writeFileSync(brokenLockDir, "a plain file sits here, not a directory");
    const registry = fileWorkspaceRegistry(tmpRegistryFile(), brokenLockDir);

    await expect(registry.set("fleetflare--scratch", "wt-1")).resolves.toBeUndefined();
  });

  test("#175: a write never leaves a partial file behind for a concurrent reader — same-directory rename, not an in-place write", async () => {
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    const registry = fileWorkspaceRegistry(path, lockDir);
    await registry.set("fleetflare--scratch", "wt-1");

    // No leftover temp file once the write settles.
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(dirname(path)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("#175: get() always reads fresh — a value another process just wrote (not through THIS registry object) is seen immediately", async () => {
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    const registry = fileWorkspaceRegistry(path, lockDir);
    expect(registry.get("fleetflare--scratch")).toBeUndefined();

    // A DIFFERENT process's write — simulated by writing the file directly,
    // never through `registry` itself.
    writeFileSync(path, JSON.stringify({ "fleetflare--scratch": "wt-from-elsewhere" }));
    expect(registry.get("fleetflare--scratch")).toBe("wt-from-elsewhere");
  });

  test("#193: 8 real processes x 25 get/sleep/set against one registry file keep all 200 keys", async () => {
    // Real OS processes, the only honest shape of #175's race: same-process
    // callers are already serialized by the event loop (see the comment above
    // the first #175 registry test). Without the registry lock, measured: 40-45
    // of the 200 keys lost per run.
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    const writer = join(import.meta.dir, "orca-workspace.registry-writer.ts");
    const procs = Array.from({ length: 8 }, (_, w) =>
      Bun.spawn(["bun", writer, path, lockDir, String(w)], { stdout: "ignore", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual(Array(8).fill(0));

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(Object.keys(onDisk)).toHaveLength(200);
    for (let w = 0; w < 8; w++) for (let i = 0; i < 25; i++) expect(onDisk[`w${w}--k${i}`]).toBe(`wt-${w}-${i}`);
  }, 60_000);

  // #193 (optional item): the registry lock guards a ~1 ms read-merge-rename,
  // not a 45 s `worktree create` — so it gets its own budgets. A held registry
  // lock costs `set` seconds, never the 60 s worktree wait; a crashed holder's
  // file is stolen after seconds, never honoured for the 120 s worktree window.

  function registryLockPath(lockDir: string): string {
    return join(lockDir, lockFileName("orca-workspace-registry-file"));
  }

  test("#193: a HELD registry lock costs set() seconds, not the 60 s worktree budget — and set() still never rejects", async () => {
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    writeFileSync(registryLockPath(lockDir), "99999"); // fresh: a live holder
    const registry = fileWorkspaceRegistry(path, lockDir);

    const t0 = Date.now();
    await expect(registry.set("fleetflare--scratch", "wt-1")).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(registry.get("fleetflare--scratch")).toBeUndefined(); // best-effort: skipped, not forced
  }, 10_000);

  test("#193: a crashed holder's registry lock is stolen after seconds, not the 120 s worktree window", async () => {
    const path = tmpRegistryFile();
    const lockDir = tmpLockDir();
    const lock = registryLockPath(lockDir);
    writeFileSync(lock, "99999");
    const old = new Date(Date.now() - 15_000);
    utimesSync(lock, old, old);
    const registry = fileWorkspaceRegistry(path, lockDir);

    const t0 = Date.now();
    await registry.set("fleetflare--scratch", "wt-1");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(registry.get("fleetflare--scratch")).toBe("wt-1");
  }, 10_000);
});


// ---------------------------------------------------------------------------
// fileLockAt — board #42's real, file-backed lock. Real filesystem, real
// exclusive-create race, no fake standing in for the mechanism itself
// (`memoryLock` in the tests above stands in for `OrcaDeps.lock`'s CONTRACT;
// this proves the actual implementation `defaultOrcaDeps()` wires holds it).

function tmpLockDir(): string {
  return mkdtempSync(join(tmpdir(), "fleet-lock-"));
}

describe("fileLockAt", () => {
  test("fileLockAt serializes two concurrent holders on the same studio id", async () => {
    const dir = tmpLockDir();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = fileLockAt(dir, "websites--maestro", async () => {
      order.push("first-acquired");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first-released");
    });
    // Give the first call a tick to actually win the exclusive-create race
    // before the second one starts trying.
    await new Promise((r) => setTimeout(r, 10));
    const second = fileLockAt(dir, "websites--maestro", async () => {
      order.push("second-acquired");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["first-acquired"]); // second is still waiting
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-acquired", "first-released", "second-acquired"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileLockAt lets two DIFFERENT studio ids run fully concurrently", async () => {
    const dir = tmpLockDir();
    const order: string[] = [];
    await Promise.all([
      fileLockAt(dir, "websites--maestro", async () => { order.push("a"); }),
      fileLockAt(dir, "websites--pilot", async () => { order.push("b"); }),
    ]);
    expect(order.sort()).toEqual(["a", "b"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileLockAt steals a stale lock left by a crashed holder instead of waiting forever", async () => {
    const dir = tmpLockDir();
    mkdirSync(dir, { recursive: true });
    const stalePath = join(dir, lockFileName("websites--maestro"));
    writeFileSync(stalePath, "99999999"); // a pid that is long gone
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes old — past LOCK_STALE_MS
    utimesSync(stalePath, old, old);

    let ran = false;
    await fileLockAt(dir, "websites--maestro", async () => { ran = true; });
    expect(ran).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileLockAt releases the lock file even when the held function throws", async () => {
    const dir = tmpLockDir();
    await expect(fileLockAt(dir, "websites--maestro", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // A second call must not be stuck behind a lock file the failed run left
    // dangling.
    let ran = false;
    await fileLockAt(dir, "websites--maestro", async () => { ran = true; });
    expect(ran).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // Issue #519 (sweep 13): the release path's `unlinkSync(path)` catch used to
  // swallow EVERY error with no trace, the same silence as the raced
  // stale-lock steal it was written for. A release failure the steal does NOT
  // explain (a real unlink error -- permissions, an unwritable dir) must log
  // one console.error; ENOENT stays silent by design (that is the steal
  // racing the holder's own release, already commented at the site). The held
  // function's result must still come back untouched -- the lock body already
  // completed, so the release failure is not the caller's failure.
  //
  // Real-fs trick, same lane as every fileLockAt test above: fileLockAt
  // acquires its own lock file for real, and the held fn then swaps that
  // file for a DIRECTORY of the same name, so the release's unlink fails
  // EISDIR (an error that is provably not ENOENT). chmod is useless here
  // (these tests run as root, which unlinks through 0o555 anyway); a directory
  // named like the lock file is deterministic.
  test("fileLockAt: a non-ENOENT release failure logs one console.error and still returns the held fn's result (#519)", async () => {
    const dir = tmpLockDir();
    const lockPath = join(dir, lockFileName("websites--maestro"));
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fileLockAt(dir, "websites--maestro", async () => {
        // Swap the lock file for a directory mid-critical-section, so
        // fileLockAt's own release unlink hits EISDIR, not ENOENT.
        rmSync(lockPath, { force: true });
        mkdirSync(lockPath);
        return "held-result";
      });
      expect(result).toBe("held-result");
      const releases = errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).filter((m) => m.includes("lock") && m.includes("release"));
      expect(releases).toHaveLength(1);
      expect(releases[0]).not.toContain("ENOENT");
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The ENOENT half of the same contract: the raced stale-lock steal already
  // commented at the release site stays SILENT -- this is already green today
  // (pinning it guards the #519 fix from over-logging the one case the site
  // explicitly documents as expected).
  test("fileLockAt: an ENOENT release (raced stale-lock steal) stays silent — pins unchanged behavior for #519", async () => {
    const dir = tmpLockDir();
    const lockPath = join(dir, lockFileName("websites--maestro"));
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fileLockAt(dir, "websites--maestro", async () => {
        rmSync(lockPath, { force: true }); // a third caller stole and released it first
        return "held-result";
      });
      expect(result).toBe("held-result");
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// Board #39: the row title reflects the studio's current task. `title` is
// display only — `studioWorkspaceName` (asserted above) is still what finds
// and creates the row; these tests are about what gets STAMPED onto it.

describe("#39 — row titles", () => {
  test("studioWorkspaceTitle formats the working task, issue number first", () => {
    const tasks = [
      boardTask({ number: 2554, title: "retire is_platform", state: "working", assignee: "acme-os--release-studio" }),
    ];
    expect(studioWorkspaceTitle("acme-os--release-studio", tasks)).toBe("acme-os · #2554 retire is_platform");
  });

  test("studioWorkspaceTitle prefers working over a newer submitted task", () => {
    // §2.2: a studio is one task at a time, so `working` is the unambiguous
    // signal of what it's doing RIGHT NOW even if something else was filed
    // against it more recently.
    const tasks = [
      boardTask({ number: 10, title: "older, still working", state: "working", assignee: "websites--maestro" }),
      boardTask({ number: 11, title: "newer, only submitted", state: "submitted", assignee: "websites--maestro", updatedAt: "2026-09-23T12:00:00Z" }),
    ];
    expect(studioWorkspaceTitle("websites--maestro", tasks)).toBe("websites · #10 older, still working");
  });

  test("studioWorkspaceTitle falls back to the newest non-completed task when nothing is working", () => {
    const tasks = [
      boardTask({ number: 5, title: "done already", state: "completed", assignee: "websites--maestro", updatedAt: "2026-09-20T00:00:00Z" }),
      boardTask({ number: 6, title: "waiting its turn", state: "submitted", assignee: "websites--maestro", updatedAt: "2026-09-22T00:00:00Z" }),
    ];
    expect(studioWorkspaceTitle("websites--maestro", tasks)).toBe("websites · #6 waiting its turn");
  });

  test("studioWorkspaceTitle ignores tasks assigned to a different studio", () => {
    const tasks = [
      boardTask({ number: 7, title: "not mine", state: "working", assignee: "websites--pilot" }),
    ];
    expect(studioWorkspaceTitle("websites--maestro", tasks)).toBe("websites · maestro (idle)");
  });

  // Issue #269 round 2: instance 1's idle title is unmarked (unchanged from
  // pre-#269), but instance n>1 needs its own idle title -- otherwise a second
  // pilot's Orca row was indistinguishable from the first's at a glance.
  test("studioWorkspaceTitle: instance 1 is unmarked, instance n>1 gets a #n suffix on the role", () => {
    expect(studioWorkspaceTitle("websites--pilot", [])).toBe("websites · pilot (idle)");
    expect(studioWorkspaceTitle("websites--pilot--2", [])).toBe("websites · pilot#2 (idle)");
    expect(studioWorkspaceTitle("websites--pilot--3", [])).toBe("websites · pilot#3 (idle)");
  });

  test("studioWorkspaceTitle truncates a long task title", () => {
    const tasks = [
      boardTask({
        number: 99,
        title: "a task title so long it would blow well past any sane sidebar row width",
        state: "working",
        assignee: "websites--maestro",
      }),
    ];
    const title = studioWorkspaceTitle("websites--maestro", tasks);
    expect(title.startsWith("websites · #99 ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThan(("websites · #99 " + tasks[0]!.title).length);
  });

  // Mandatory test 1 (board #39): the title reflects the assigned task — and
  // is actually WIRED to Orca, not just correct as a pure function.
  test("row title reflects the assigned working task, end to end", async () => {
    const tasks = [
      boardTask({ number: 2554, title: "retire is_platform", state: "working", assignee: "acme-os--release-studio" }),
    ];
    const title = studioWorkspaceTitle("acme-os--release-studio", tasks);
    expect(title).toBe("acme-os · #2554 retire is_platform");

    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": ok(JSON.stringify({
        result: { worktree: { id: "wt-acme-release", displayName: "studio-acme-os--release-studio" } },
      })),
      "terminal list": terminals(),
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace("acme-os--release-studio", title, f.deps);
    expect(outcome.kind).toBe("created");

    // `worktree set --display-name`, not `worktree rename --name` — the latter
    // does not exist on real Orca 1.4.198 (MEASURED: "Unknown command: worktree
    // rename"). See the comment above the call site in orca-workspace.ts.
    const set = f.calls.find((c) => c[0] === "worktree" && c[1] === "set");
    expect(set).toBeDefined();
    expect(set).toContain("--display-name");
    expect(set).toContain(title);
  });

  // Mandatory test 2 (board #39): idle fallback.
  test("row title falls back to <repo> · <role> (idle) when nothing is assigned", () => {
    expect(studioWorkspaceTitle("acme-os--release-studio", [])).toBe("acme-os · release-studio (idle)");
    // Also idle when the only assigned task is already completed — "assigned"
    // is not the same as "currently being worked".
    const onlyCompleted = [
      boardTask({ number: 1, title: "shipped", state: "completed", assignee: "acme-os--release-studio" }),
    ];
    expect(studioWorkspaceTitle("acme-os--release-studio", onlyCompleted)).toBe("acme-os · release-studio (idle)");
  });

  // Mandatory test 3 (board #39) — the regression guard for board #11.
  // Two ensureStudioWorkspace calls for the SAME studio, with two DIFFERENT
  // resulting titles (idle -> working), must still leave exactly one row.
  //
  // This fake is deliberately stateful (unlike the generic `fake()` helper,
  // which answers the same canned response every call) and deliberately models
  // the WORST case for this design: `worktree set --display-name` actually
  // mutates the fake's own `displayName`, so the second call's `worktree list`
  // does NOT report the original `studio-<id>` stable name anymore. If the lookup in
  // `ensure()` depended on `displayName` staying put, this test would fail by
  // creating a second worktree on the second call — proving the registry-based
  // lookup (not an accident of `displayName` never changing) is what carries
  // the idempotency.
  test("two calls with different titles (idle -> working) leave exactly one row", async () => {
    const state: { worktree: { id: string; displayName: string } | null; connected: boolean } = {
      worktree: null,
      connected: false,
    };
    const calls: string[][] = [];
    const deps: OrcaDeps = {
      env: ORCA_ENV,
      hasBinary: () => "orca",
      log: () => {},
      registry: memoryRegistry(),
      lock: (_id, fn) => fn(),
      run: async (args) => {
        calls.push(args);
        const [a, b] = args;
        if (a === "worktree" && b === "list") {
          return ok(JSON.stringify({ result: { worktrees: state.worktree ? [state.worktree] : [] } }));
        }
        if (a === "repo" && b === "list") return REPOS;
        if (a === "worktree" && b === "create") {
          state.worktree = { id: "wt-1", displayName: "studio-acme-os--release-studio" };
          return ok(JSON.stringify({ result: { worktree: state.worktree } }));
        }
        if (a === "worktree" && b === "set") {
          const nameIdx = args.indexOf("--display-name");
          if (state.worktree && nameIdx !== -1) {
            state.worktree = { ...state.worktree, displayName: args[nameIdx + 1]! };
          }
          return ok("{}");
        }
        if (a === "terminal" && b === "list") {
          return ok(JSON.stringify({
            result: { terminals: state.connected ? [{ handle: "t1", title: "fleet", connected: true }] : [] },
          }));
        }
        if (a === "terminal" && b === "create") {
          state.connected = true;
          return TERM_CREATED;
        }
        return ok("{}");
      },
    };

    const idleTitle = "acme-os · release-studio (idle)";
    const workingTitle = "acme-os · #2554 retire is_platform";

    const first = await ensureStudioWorkspace("acme-os--release-studio", idleTitle, deps);
    expect(first.kind).toBe("created");

    const second = await ensureStudioWorkspace("acme-os--release-studio", workingTitle, deps);
    expect(second.kind).toBe("exists");

    const creates = calls.filter((c) => c[0] === "worktree" && c[1] === "create");
    expect(creates.length).toBe(1);
    expect(state.worktree?.displayName).toBe(workingTitle);
  });
});


// ---------------------------------------------------------------------------
// Board #55 (+ #57 item 4): teardown must find a TASK-TITLED row. Since #39
// the row's displayName is the current task, never `studio-<id>`, so a
// displayName-only lookup reported "absent — teardown already complete" and
// left the stale row standing. Same lookup `ensure` uses: registry id first.

describe("#55 — teardown finds task-titled rows", () => {
  test("#55: removeStudioWorkspace finds a task-titled row by its registry id", async () => {
    const wt = tmpWorktree();
    const registry = memoryRegistry();
    await registry.set("websites--maestro", "repo-websites::/w/task-row");
    const f = fake({
      "worktree list": ok(JSON.stringify({ ok: true, result: { worktrees: [
        { id: "repo-websites::/w/task-row", displayName: "websites · #7 some task", path: wt },
      ] } })),
      "terminal list": terminals(true),
    }, { registry });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("removed");
    expect(f.calls.find((c) => c[0] === "worktree" && c[1] === "rm")).toContain(`path:${wt}`);
  });
});


// ---------------------------------------------------------------------------
// Board #55 defect B + #57 item 4: `fleet ls` ROW column. The local Orca row
// is the operator's view of a studio; it must say when that view lies.

const WT = { id: "wt-1", displayName: "websites · #7 some task" };
const st = (state: StudioStatus["state"], containerRunningSince: string | null = null) =>
  ({ state, containerRunningSince }) as StudioStatus;
const fleetTerm = (over: Record<string, unknown> = {}) =>
  ({ handle: "t", title: "fleet", connected: true, orphaned: false, writable: true, worktreeId: "wt-1", ...over });

function studio(id: string, state: StudioStatus["state"]): StudioStatus {
  return { id, state } as StudioStatus;
}

describe("#55 — fleet ls ROW column", () => {
  test("#55: ROW — stopped studio, no row: teardown finished", () => {
    expect(classifyStudioRow(st("stopped"), undefined, [])).toBe("none");
  });

  test("#55: ROW — stopped studio whose row survives: STALE", () => {
    expect(classifyStudioRow(st("stopped"), WT, [fleetTerm()])).toBe("STALE row");
  });

  test("#55: ROW — running studio with a healthy attach terminal", () => {
    expect(classifyStudioRow(st("running"), WT, [fleetTerm()])).toBe("ok");
  });

  test("#55: ROW — running studio whose attach is orphaned/unwritable: DEAD", () => {
    expect(classifyStudioRow(st("running"), WT, [fleetTerm({ orphaned: true, connected: false, writable: false })]))
      .toBe("attach DEAD");
  });

  test("#55: ROW — a plain shell is not an attach terminal", () => {
    expect(classifyStudioRow(st("running"), WT, [fleetTerm({ title: "zsh" })])).toBe("NO attach");
  });

  test("#55: ROW — running studio with no row at all is invisible", () => {
    expect(classifyStudioRow(st("running"), undefined, [])).toBe("NO row");
  });

  // #206: #153's attach client retitles its own terminal via OSC
  // (`attachTitle`). Matching only the pre-#153 title "fleet" read every
  // #153 client as `NO attach`, and ensure/tabs stacked another beside it.
  const ID = "websites--maestro";
  const stId = (id: string) => ({ id, state: "running", containerRunningSince: null }) as StudioStatus;
  const STALE_TITLE = attachTitle(ID, { since: Date.UTC(2026, 8, 24, 21, 0, 0), now: Date.UTC(2026, 8, 24, 21, 2, 0) });

  test("#206: ROW — a connected #153-titled live attach reads ok", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: attachTitle(ID, "live") })])).toBe("ok");
  });

  test("#206: ROW — a #153 attach still waiting for its first frame reads ok", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: attachTitle(ID, "waiting") })])).toBe("ok");
  });

  test("#206: ROW — a STALE #153 attach reads 'attach STALE'", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: STALE_TITLE })])).toBe("attach STALE");
  });

  test("#206: ROW — another studio's #153 title never matches, even one whose id extends this one", () => {
    for (const other of ["websites--pilot", `${ID}x`]) {
      expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: attachTitle(other, "live") })])).toBe("NO attach");
    }
  });

  test("#206: ROW — the pre-#153 title 'fleet' still matches", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: "fleet" })])).toBe("ok");
  });

  test("#206: ensure opens no new terminal beside a connected #153-titled attach", async () => {
    for (const title of [attachTitle(ID, "live"), STALE_TITLE]) {
      const f = fake({
        "worktree list": worktrees("staging", "studio-websites--maestro"),
        "terminal list": terminalEntries({ handle: "term_153", title, connected: true }),
        "repo list": REPOS,
        "worktree create": CREATED,
        "terminal create": TERM_CREATED,
      });
      const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
      expect(outcome.kind).toBe("exists");
      expect(f.calls.some((c) => c[0] === "terminal" && (c[1] === "create" || c[1] === "close"))).toBe(false);
    }
  });

  test("#206: ensure does not accept ANOTHER studio's #153 attach as this one's", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_other", title: attachTitle("websites--pilot", "live"), connected: true }),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(true);
  });

  test("#206: fleet tabs counts a #153-titled attach as existing, not opened", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_153", title: attachTitle(ID, "live"), connected: true }),
      "terminal create": TERM_CREATED,
    });
    const report = await reconcileStudioWorkspaces([studio(ID, "running")], () => TEST_TITLE, f.deps);
    expect(report.existing).toEqual([ID]);
    expect(report.opened).toEqual([]);
  });

  test("#206: ROW — a STALE title of an id that extends this one never matches", () => {
    const since = Date.UTC(2026, 8, 24, 21, 0, 0);
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: attachTitle(`${ID}x`, { since, now: since + 120_000 }) })]))
      .toBe("NO attach");
  });

  test("#206: ROW — a disconnected STALE-titled terminal reads 'attach DEAD'", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: STALE_TITLE, connected: false })])).toBe("attach DEAD");
  });

  // #206 round 2, MEASURED live on Orca 1.4.209 (2026-09-24 23:35Z): a freshly
  // created attach terminal lists title `<id>` (ensure's own --title / rename)
  // for minutes before the #153 client's OSC title lands.
  test("#206: ROW — a connected terminal titled with the bare studio id reads ok", () => {
    expect(classifyStudioRow(stId(ID), WT, [fleetTerm({ title: ID })])).toBe("ok");
  });

  test("#206: ROW — a bare-id title matches exactly, never a longer or shorter id", () => {
    expect(classifyStudioRow(stId("x--web"), WT, [fleetTerm({ title: "x--web-studio" })])).toBe("NO attach");
    expect(classifyStudioRow(stId("x--web-studio"), WT, [fleetTerm({ title: "x--web" })])).toBe("NO attach");
  });

  test("#206: ensure opens no new terminal beside a bare-id-titled attach", async () => {
    const f = fake({
      "worktree list": worktrees("staging", "studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_fresh", title: ID, connected: true }),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("exists");
    expect(f.calls.some((c) => c[0] === "terminal" && (c[1] === "create" || c[1] === "close"))).toBe(false);
  });

  test("#206: fleet tabs counts a bare-id-titled attach as existing", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "term_fresh", title: ID, connected: true }),
      "terminal create": TERM_CREATED,
    });
    const report = await reconcileStudioWorkspaces([studio(ID, "running")], () => TEST_TITLE, f.deps);
    expect(report.existing).toEqual([ID]);
    expect(report.opened).toEqual([]);
  });

  test("#206: dedupe keeps the #153 live client over newer bare-id duplicates", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_id_a", title: ID, connected: true, lastOutputAt: "2026-09-24T23:40:00Z" },
        { handle: "term_live", title: attachTitle(ID, "live"), connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
        { handle: "term_id_b", title: ID, connected: true, lastOutputAt: "2026-09-24T23:41:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect([...(outcome.closedDuplicates ?? [])].sort()).toEqual(["term_id_a", "term_id_b"]);
  });

  test("#206: dedupe never keeps a STALE client over a live one, however recent", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_stale", title: STALE_TITLE, connected: true, lastOutputAt: "2026-09-24T23:40:00Z" },
        { handle: "term_fleet", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_stale"]);
  });

  // #206 round 3: a peer maestro caches the handle `terminal create` gave it.
  // Pruning the OLDER client killed that cached handle silently. Among equally
  // healthy clients keep the oldest — Orca exposes no creation time and
  // handles are random UUIDs, so "oldest" is the earliest in `terminal list`
  // order — UNLESS (#220 fix round) the gap between the two clients'
  // `lastOutputAt` exceeds the 90s staleness window: two clients of ONE shared
  // tmux session normally see near-identical frames, so a 10-minute gap here
  // means term_older stopped receiving frames entirely (frozen/wedged) without
  // Orca ever marking it orphaned — exactly the live #206 pre-#153-client
  // scenario #220's own review comment raised. It is demoted, and the fresher
  // term_newer is kept instead.
  test("#206: dedupe among equally healthy live clients, more than 90s apart, keeps the fresher one (#220)", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_older", title: attachTitle(ID, "live"), connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
        { handle: "term_newer", title: attachTitle(ID, "live"), connected: true, lastOutputAt: "2026-09-24T23:40:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace(ID, TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_older"]);
  });

  test("#206: readStudioRows keys the #153 title by each studio's own id", async () => {
    const registry = memoryRegistry();
    await registry.set(ID, "wt-1");
    const f = fake({
      "worktree list": ok(JSON.stringify({ ok: true, result: { worktrees: [WT] } })),
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [fleetTerm({ title: attachTitle(ID, "live") })] } })),
    }, { registry });
    const rows = await readStudioRows([{ id: ID, state: "running" }] as StudioStatus[], f.deps);
    expect(rows.rows.get(ID)).toBe("ok");
  });

  test("#55: readStudioRows — one worktree list + one terminal list, keyed by studio id", async () => {
    const registry = memoryRegistry();
    await registry.set("websites--maestro", "wt-1");
    const f = fake({
      "worktree list": ok(JSON.stringify({ ok: true, result: { worktrees: [WT] } })),
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [fleetTerm({ orphaned: true })] } })),
    }, { registry });
    const rows = await readStudioRows(
      [{ id: "websites--maestro", state: "running" }, { id: "websites--pilot", state: "stopped" }] as StudioStatus[],
      f.deps,
    );
    expect(rows.rows.get("websites--maestro")).toBe("attach DEAD");
    expect(rows.rows.get("websites--pilot")).toBe("none");
    expect(f.calls.length).toBe(2);
  });

  // #299: every "no verdict" source explains itself. An unavailable column
  // reads `?` (never the bare `-` that looked like a verdict) plus ONE stdout
  // footer naming why — stderr alone was lost under `fleet ls 2>&1 | grep`.
  const PILOT = [{ id: "websites--maestro", state: "running" } as StudioStatus];

  test("#55/#299: readStudioRows — outside Orca makes no call; column `?`, footer says not under Orca", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    const out = await readStudioRows(PILOT, f.deps);
    expect(f.calls).toEqual([]);
    expect(out.rows.get("websites--maestro")).toBe("?");
    expect(out.footer).toMatch(/^ROW \?: not running under Orca/);
  });

  test("#299: readStudioRows — orca binary missing; column `?`, footer names the binary", async () => {
    const f = fake({}, { hasBinary: () => null });
    const out = await readStudioRows(PILOT, f.deps);
    expect(f.calls).toEqual([]);
    expect(out.rows.get("websites--maestro")).toBe("?");
    expect(out.footer).toMatch(/^ROW \?: orca binary not found/);
  });

  test("#55/#299: readStudioRows — an orca failure never fails fleet ls; column `?`, footer carries the why", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "boom", timedOut: false } as OrcaResult });
    const out = await readStudioRows(PILOT, f.deps);
    expect(out.rows.get("websites--maestro")).toBe("?");
    expect(out.footer).toMatch(/^ROW \?: Orca did not answer — orca worktree list failed: boom/);
  });

  test("#299: readStudioRows — the live 2026-09-25 case, a 3s timeout, names the timeout in the footer", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "", timedOut: true } as OrcaResult });
    const out = await readStudioRows(PILOT, f.deps);
    expect(out.rows.get("websites--maestro")).toBe("?");
    expect(out.footer).toContain("orca worktree list timed out after 3s");
  });

  test("#299: readStudioRows — a full answer has no footer", async () => {
    const f = fake({ "worktree list": ok(JSON.stringify({ ok: true, result: { worktrees: [] } })), "terminal list": terminals() });
    const out = await readStudioRows(PILOT, f.deps);
    expect(out.rows.get("websites--maestro")).toBe("NO row");
    expect(out.footer).toBeNull();
  });

  // Board #55: live Orca 1.4.209 reports `lastOutputAt` as epoch-ms NUMBER, not
  // a string. Ranking two equally healthy duplicates called `.localeCompare` on
  // it and threw — so the dedupe failed on exactly the case it exists for.
  // #206 round 3: ranking no longer PREFERS by `lastOutputAt` for its own sake;
  // ties keep the earliest listed (oldest), so the numeric case still never
  // throws. #220 fix round: these two numbers are ~2.76 hours apart — well past
  // the 90s staleness window — so "old" is now demoted (see the two tests
  // above/below this one that keep the pre-#220 "ties keep the oldest" rule
  // alive for gaps that are actually just noise) and "new" survives instead.
  test("#55: duplicate ranking survives numeric lastOutputAt, and demotes the one over 90s stale (#220)", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [
        { handle: "old", title: "fleet", connected: true, lastOutputAt: 1790253320126 },
        { handle: "new", title: "fleet", connected: true, lastOutputAt: 1790263260987 },
      ] } })),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome).toEqual({ kind: "exists", closedDuplicates: ["old"] });
  });
});


// ---------------------------------------------------------------------------
// Board #220: the ranking scope-add. Two clients of ONE shared tmux session
// normally see near-identical `lastOutputAt` frames (#206 round 3's own
// reasoning for why the old blanket tie-break was removed) — so a gap PAST
// the 90s staleness window (attach-liveness.ts's own ATTACH_STALE_MS: "tmux
// redraws its status-line clock every minute, so a live pty never goes 90s
// frameless") means one client stopped receiving frames entirely, not that
// the two are merely slightly out of sync. The reviewer's own #220 framing:
// "among equally healthy clients, demote a client whose lastOutputAt is more
// than 90s behind the newest, then keep the oldest." Demotion compares
// against the newest WITHIN the same tied (badness+liveness) group, never a
// global newest — the four cases above (all pinned pre-#220 tests updated to
// this rule) plus the four below prove both the demotion and that it never
// fires for the cases #206 round 3 actually cared about.

describe("#220 — ranking scope-add", () => {
  test("#220: within 90s of each other (NUMBER epoch-ms) — oldest (list order) still wins, exactly as #206 round 3 intended", async () => {
    const base = 1_790_000_000_000;
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_first", title: "fleet", connected: true, lastOutputAt: base },
        { handle: "term_second", title: "fleet", connected: true, lastOutputAt: base + 60_000 }, // 60s later, < 90s
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_second"]);
  });

  test("#220: within 90s of each other (ISO string) — oldest (list order) still wins", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_first", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
        { handle: "term_second", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:31:00Z" }, // 60s later
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_second"]);
  });

  test("#220: more than 90s behind the newest (ISO string) — the fresher one wins even though it's not the oldest", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        // term_frozen was listed FIRST (would win under plain oldest-wins) but
        // its last frame is 5 minutes behind term_fresh's — well past 90s.
        { handle: "term_frozen", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:25:00Z" },
        { handle: "term_fresh", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_frozen"]);
  });

  test("#220: a candidate with no lastOutputAt at all is never demoted for lacking it — still competes purely on oldest-wins", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        // term_no_output is listed first (oldest) and reports NO lastOutputAt
        // field at all — e.g. a brand-new client that hasn't had a chance to
        // report output yet. It must not lose to term_reported just because it
        // has nothing to compare — the same "missing fields read as the
        // healthy default" convention this file already applies to
        // `orphaned`/`writable`.
        { handle: "term_no_output", title: "fleet", connected: true },
        { handle: "term_reported", title: "fleet", connected: true, lastOutputAt: "2026-09-24T23:30:00Z" },
      ),
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    if (outcome.kind !== "exists") throw new Error(`expected exists, got ${outcome.kind}`);
    expect(outcome.closedDuplicates).toEqual(["term_reported"]);
  });
});


// ---------------------------------------------------------------------------
// #124 follow-up. M1/M3/N4: a partial or unreadable Orca answer must read
// "-", never a confident "none"/"NO row".

const LIST_OK = (key: "worktrees" | "terminals", rows: unknown[], extra: Record<string, unknown> = {}) =>
  ok(JSON.stringify({ ok: true, result: { [key]: rows, truncated: false, ...extra } }));

describe("#124/#299/#516/#135 — partial answers", () => {
  test("#124: readStudioRows asks for every row (--limit 10000) on both calls", async () => {
    const f = fake({ "worktree list": LIST_OK("worktrees", []), "terminal list": LIST_OK("terminals", []) });
    await readStudioRows([st("stopped")].map((s) => ({ ...s, id: "websites--pilot" })), f.deps);
    expect(f.calls.length).toBe(2);
    for (const c of f.calls) expect(c.slice(c.indexOf("--limit"), c.indexOf("--limit") + 2)).toEqual(["--limit", "10000"]);
  });

  test("#124/#299: readStudioRows — a truncated list reads '?', never 'none', and says truncated", async () => {
    const f = fake({
      "worktree list": LIST_OK("worktrees", [], { truncated: true }),
      "terminal list": LIST_OK("terminals", []),
    });
    const out = await readStudioRows([{ id: "websites--pilot", state: "stopped" } as StudioStatus], f.deps);
    expect(out.rows.get("websites--pilot")).toBe("?");
    expect(out.footer).toContain("orca worktree list truncated");
  });

  test("#124/#299: readStudioRows — unparseable orca output reads '?', never 'none', and says why", async () => {
    const f = fake({ "worktree list": ok("not json"), "terminal list": LIST_OK("terminals", []) });
    const out = await readStudioRows([{ id: "websites--pilot", state: "stopped" } as StudioStatus], f.deps);
    expect(out.rows.get("websites--pilot")).toBe("?");
    expect(out.footer).toContain("orca worktree list printed unparseable JSON");
  });

  test("#516: orcaJson throws on unparseable output — a 0-exit non-JSON answer never decodes as an empty envelope", async () => {
    const f = fake({ "worktree list": ok("not json") });
    const out = await ensureStudioWorkspace("websites--pilot", TEST_TITLE, f.deps);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.why).toContain("printed unparseable JSON");
    // mis-decoding `{}` would read [] worktrees and CREATE a duplicate row — the exact bug
    expect(f.calls.some((c) => c[0] === "worktree" && c[1] === "create")).toBe(false);
    expect(f.calls.some((c) => c[0] === "repo" && c[1] === "list")).toBe(false);
  });

  // N2: a "stopped" studio whose container still runs is billing — its row is
  // the only thing showing it. Never call that row STALE (an invitation to
  // remove it).
  test("#124: ROW — stopped-but-container-running studio is judged as running", () => {
    expect(classifyStudioRow(st("stopped", "2026-09-24T12:39:08.000Z"), WT, [fleetTerm()])).toBe("ok");
    expect(classifyStudioRow(st("stopped", "2026-09-24T12:39:08.000Z"), undefined, [])).toBe("NO row");
  });

  test("#124/#299: ROW — a worktree Orca gave no id cannot be judged: '? no id'", () => {
    expect(classifyStudioRow(st("running"), {}, [fleetTerm()])).toBe("? no id");
  });

  // M2: ONE rule. `fleet tabs` (ensure) must repair what the column calls
  // dead — a connected-but-orphaned attach is replaced, not kept.
  test("#124: ROW — connected but orphaned attach is DEAD", () => {
    expect(classifyStudioRow(st("running"), WT, [fleetTerm({ orphaned: true })])).toBe("attach DEAD");
    expect(classifyStudioRow(st("running"), WT, [fleetTerm({ writable: false })])).toBe("attach DEAD");
  });

  test("#124: fleet tabs replaces a connected-but-orphaned attach terminal", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({ handle: "dead", title: "fleet", connected: true, orphaned: true, writable: false }),
      "terminal create": TERM_CREATED,
    });
    const outcome = await ensureStudioWorkspace("websites--maestro", TEST_TITLE, f.deps);
    expect(outcome.kind).toBe("created");
    const close = f.calls.find((c) => c[0] === "terminal" && c[1] === "close");
    expect(close).toContain("dead");
    expect(f.calls.some((c) => c[0] === "terminal" && c[1] === "create")).toBe(true);
  });

  // Item 7 — LIVE 2026-09-24 16:01Z: destroy printed "teardown already
  // complete" while the studio's attach terminal was alive; it reconnected and
  // booted a new billing container. Absence is only claimed once the terminal
  // list has been checked for a stray attach, and a failed/partial lookup says
  // "could not verify", never "complete".

  test("#124: removal with no worktree still closes a stray attach terminal by worktree path, and names it", async () => {
    const f = fake({
      "worktree list": LIST_OK("worktrees", []),
      "terminal list": LIST_OK("terminals", [
        { handle: "stray", title: "fleet", connected: true, worktreePath: "/Users/x/orca/workspaces/websites/studio-websites-maestro" },
        { handle: "other", title: "fleet", connected: true, worktreePath: "/Users/x/orca/workspaces/websites/studio-websites-pilot" },
      ]),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome).toEqual({
      kind: "absent", closedAttach: ["stray"],
      survivingPaths: ["/Users/x/orca/workspaces/websites/studio-websites-maestro"],
    });
    const closes = f.calls.filter((c) => c[0] === "terminal" && c[1] === "close");
    expect(closes.map((c) => c[c.indexOf("--terminal") + 1])).toEqual(["stray"]);
    const lines = describeWorkspaceRemoval("websites--maestro", outcome);
    expect(lines.join("\n")).toContain("stray");
    expect(lines.join("\n")).not.toContain("already complete");
  });

  test("#124: removal whose lookup FAILS says could-not-verify, never complete", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "orca wedged", timedOut: false } as OrcaResult });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("unverified");
    const lines = describeWorkspaceRemoval("websites--maestro", outcome).join("\n");
    expect(lines).toContain("could not verify teardown: ");
    expect(lines).toContain("orca wedged");
    expect(lines).toContain(
      "close any attach terminal for websites--maestro by hand — a live attach restarts the container",
    );
    expect(lines).not.toContain("complete");
  });

  test("#124: removal whose lookup is TRUNCATED says could-not-verify", async () => {
    const f = fake({
      "worktree list": LIST_OK("worktrees", [], { truncated: true }),
      "terminal list": LIST_OK("terminals", []),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome.kind).toBe("unverified");
    expect(describeWorkspaceRemoval("websites--maestro", outcome).join("\n")).toContain("could not verify teardown: ");
  });

  test("#124: removal with no worktree and no stray terminal never says 'already complete'", () => {
    const lines = describeWorkspaceRemoval("websites--maestro", { kind: "absent", closedAttach: [], survivingPaths: [] }).join("\n");
    expect(lines).not.toContain("already complete");
    expect(lines).toContain("no Orca worktree or attach terminal found");
  });

  // #135 review 1: the no-row path's SECOND lookup (terminal sweep) failing or
  // partial must also read could-not-verify — mutation that returns `absent`
  // from that catch has to fail here.
  for (const [label, answer] of [
    ["FAILS", { ok: false, stdout: "", stderr: "terminal list wedged", timedOut: false } as OrcaResult],
    ["is TRUNCATED", ok(JSON.stringify({ ok: true, result: { terminals: [], truncated: true } }))],
  ] as const) {
    test(`#135: no row, and the terminal sweep ${label}: could-not-verify, never complete`, async () => {
      const f = fake({ "worktree list": LIST_OK("worktrees", []), "terminal list": answer });
      const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
      expect(outcome.kind).toBe("unverified");
      const lines = describeWorkspaceRemoval("websites--maestro", outcome).join("\n");
      expect(lines).toContain("could not verify teardown");
      expect(lines).not.toContain("complete");
    });
  }

  // #135 review 2: the only live orphaned PTY (tab-less, tabId `pty:…`) reports
  // title null. A tab-less attach is an invisible reconnecting client — the
  // incident class. Match by folder, any title.
  test("#135: sweep closes an orphaned, title-null terminal in the studio folder, and names it", async () => {
    const path = "/Users/x/orca/workspaces/websites/studio-websites-maestro";
    const f = fake({
      "worktree list": LIST_OK("worktrees", []),
      "terminal list": LIST_OK("terminals", [
        { handle: "ghost", title: null, tabId: "pty:abc", orphaned: true, connected: true, worktreePath: path },
      ]),
    });
    const outcome = await removeStudioWorkspace("websites--maestro", f.deps, tmpSalvageRoot());
    expect(outcome).toEqual({ kind: "absent", closedAttach: ["ghost"], survivingPaths: [path] });
    expect(describeWorkspaceRemoval("websites--maestro", outcome).join("\n")).toContain("ghost");
  });

  // #135 review 4: a terminal in the studio folder proves the worktree still
  // exists — the lookup missed it. Name the path and the by-PATH removal;
  // never "no Orca worktree found".
  test("#135: a surviving studio folder is named with its by-path removal command", () => {
    const path = "/Users/x/orca/workspaces/websites/studio-websites-maestro";
    const lines = describeWorkspaceRemoval(
      "websites--maestro", { kind: "absent", closedAttach: ["stray"], survivingPaths: [path] },
    ).join("\n");
    expect(lines).not.toContain("no Orca worktree found");
    expect(lines).toContain(path);
    expect(lines).toContain(`orca worktree rm --worktree "path:${path}"`);
  });
});


// ---------------------------------------------------------------------------
// Board #322: the pair functions. Every single-studio caller used to sequence
// `studioWorkspaceTitle` + `ensureStudioWorkspace` (or
// `removeStudioWorkspace` + `describeWorkspaceRemoval`) itself; `openStudioRow`
// and `closeStudioRow` are those pairs. These characterization tests pin what
// each pair produces THROUGH the new interface — the exact title derived from
// tasks, the outcome, and the printed lines — with the same fakes every suite
// above already uses.

describe("#322 — pair functions", () => {
  test("openStudioRow: a working task — the derived `repo · #N <title>` is what reaches Orca, and the outcome flows through", async () => {
    const tasks = [
      boardTask({ number: 2554, title: "retire is_platform", state: "working", assignee: "acme-os--release-studio" }),
    ];
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": ok(JSON.stringify({
        result: { worktree: { id: "wt-acme-release", displayName: "studio-acme-os--release-studio" } },
      })),
      "terminal list": terminals(),
      "terminal create": TERM_CREATED,
    });
    const outcome = await openStudioRow("acme-os--release-studio", tasks, f.deps);

    expect(outcome.kind).toBe("created");
    const set = f.calls.find((c) => c[0] === "worktree" && c[1] === "set");
    expect(set).toBeDefined();
    expect(set).toContain("--display-name");
    expect(set).toContain("acme-os · #2554 retire is_platform");
  });

  test("openStudioRow: idle (no tasks) — the `repo · role (idle)` title reaches Orca the same way", async () => {
    const f = fake({
      "worktree list": worktrees(),
      "repo list": REPOS,
      "worktree create": CREATED,
      "terminal list": terminals(),
      "terminal create": TERM_CREATED,
    });
    const outcome = await openStudioRow("websites--maestro", [], f.deps);

    expect(outcome.kind).toBe("created");
    const set = f.calls.find((c) => c[0] === "worktree" && c[1] === "set");
    expect(set).toContain("websites · maestro (idle)");
  });

  test("openStudioRow: not running under Orca — skipped, zero orca calls", async () => {
    const f = fake({}, { hasBinary: () => null });
    const outcome = await openStudioRow("websites--maestro", [], f.deps);
    expect(f.calls).toEqual([]);
    expect(outcome).toEqual({ kind: "skipped", why: "not running under Orca" });
  });

  test("closeStudioRow: removed — the same lines describeWorkspaceRemoval prints, salvage line included when .context/ had files", async () => {
    const wt = tmpWorktree({ ".context/shot.png": "PNGDATA" }, "studio-websites--maestro");
    const f = fake({
      "worktree list": worktreesWithPath({ displayName: "studio-websites--maestro", path: wt }),
      "terminal list": terminals(),
    });
    // The 2-param call IS the production shape: the DEFAULT salvage destination
    // — `join(homedir(), "fleet-teardown-salvage")` — is what flows through, so
    // left alone this test would mkdir+cp the fixture into the operator's REAL
    // home on every run (2026-10-10: nine stray fixture dirs found in
    // /root/fleet-teardown-salvage from exactly that). Redirecting it cannot be
    // `process.env.HOME = ...`: Bun's `os.homedir()` snapshots $HOME at process
    // LAUNCH, so a runtime mutation is a no-op here (measured: mutating before
    // or after the first call changes nothing). The working redirect is
    // `mock.module` of the node:os system boundary — captured real exports
    // spread back in `finally`, because an unrestored mock.module leaks to every
    // LATER test and file in the same bun process (measured too). The spread is
    // the REAL os only because nothing else mocks node:os before this file
    // loads — this is the repo's only node:os mock (a second one would have
    // to capture before that one).
    const tmpHome = mkdtempSync(join(tmpdir(), "orca-salvage-home-"));
    const realOs = { ...nodeOs }; // copied at capture, so the mock cannot rewrite it
    await mock.module("node:os", () => ({ ...realOs, homedir: () => tmpHome }));
    try {
      const lines = await closeStudioRow("websites--maestro", f.deps);
      expect(lines[0]).toBe("websites--maestro: Orca worktree and attach terminal removed");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("salvaged .context/");
      // The redirect held: the destination the operator would be told to look in
      // is under the temp HOME, never the real one.
      expect(lines[1]).toContain(join(tmpHome, "fleet-teardown-salvage"));
    } finally {
      await mock.module("node:os", () => ({ ...realOs }));
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("closeStudioRow: absent — the single teardown-complete line, byte-identical to describeWorkspaceRemoval's", async () => {
    const f = fake({
      "worktree list": worktrees("staging"),
      "terminal list": ok(JSON.stringify({ ok: true, result: { terminals: [] } })),
    });
    const lines = await closeStudioRow("websites--maestro", f.deps);
    expect(lines).toEqual([
      "websites--maestro: no Orca worktree or attach terminal found — teardown complete",
    ]);
  });

  test("closeStudioRow: skipped (no Orca) — no lines, no orca calls", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    const lines = await closeStudioRow("websites--maestro", f.deps);
    expect(lines).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("closeStudioRow: unverified (orca lookup fails) — the could-not-verify line, never a confident one", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "orca wedged", timedOut: false } });
    const lines = await closeStudioRow("websites--maestro", f.deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not verify teardown: orca worktree list failed: orca wedged");
    expect(lines.join("\n")).not.toContain("teardown complete");
  });
});


// ---------------------------------------------------------------------------
// Board #220: `findAttachHandle` — the read-only lookup a coordinator needs
// to send a blocked lead's Orca terminal a keystroke, without running
// `fleet tabs` (a RECONCILING command — creates/closes/renames terminals as
// a side effect, #206) just to find a handle. Built on `readStudioRows`'s own
// template: the SAME two `worktree list`/`terminal list` reads, never a
// `terminal create`/`close`/`rename` call.

describe("#220 — findAttachHandle", () => {
  test("#220: findAttachHandle returns the healthy attach terminal's handle", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({
        handle: "term_healthy", title: "fleet", connected: true,
        worktreeId: "repo-websites::/w/studio-websites--maestro",
      }),
    });
    expect(await findAttachHandle("websites--maestro", f.deps)).toBe("term_healthy");
    // Strictly read-only: only the two LIST calls readStudioRows itself makes.
    expect(f.calls.every((c) => c[1] === "list")).toBe(true);
  });

  test("#220: findAttachHandle returns null when the studio has no worktree", async () => {
    const f = fake({
      "worktree list": worktrees("staging"), // no row for websites--maestro
      "terminal list": terminals(),
    });
    expect(await findAttachHandle("websites--maestro", f.deps)).toBeNull();
  });

  test("#220: findAttachHandle returns null when the worktree exists but has no attach terminal", async () => {
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries({
        handle: "term_shell", title: "zsh", connected: true,
        worktreeId: "repo-websites::/w/studio-websites--maestro",
      }),
    });
    expect(await findAttachHandle("websites--maestro", f.deps)).toBeNull();
  });

  test("#220: findAttachHandle returns null and makes no orca call outside Orca", async () => {
    const f = fake({}, { env: { TERM_PROGRAM: "Apple_Terminal" } });
    expect(await findAttachHandle("websites--maestro", f.deps)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("#220: findAttachHandle returns null, logs, and never throws when an orca call fails", async () => {
    const f = fake({ "worktree list": { ok: false, stdout: "", stderr: "orca wedged", timedOut: false } });
    await expect(findAttachHandle("websites--maestro", f.deps)).resolves.toBeNull();
    expect(f.lines.length).toBe(1);
    expect(f.lines[0]).toContain("orca wedged");
  });

  test("#220: findAttachHandle picks the best-ranked candidate's handle when more than one exists", async () => {
    const wtId = "repo-websites::/w/studio-websites--maestro";
    const f = fake({
      "worktree list": worktrees("studio-websites--maestro"),
      "terminal list": terminalEntries(
        { handle: "term_orphaned", title: "fleet", connected: true, orphaned: true, worktreeId: wtId },
        { handle: "term_healthy", title: "fleet", connected: true, worktreeId: wtId },
      ),
    });
    // Both connected + attach-titled, but only one is HEALTHY (isHealthyAttach)
    // — the orphaned one is filtered out before ranking even runs.
    expect(await findAttachHandle("websites--maestro", f.deps)).toBe("term_healthy");
  });
});
