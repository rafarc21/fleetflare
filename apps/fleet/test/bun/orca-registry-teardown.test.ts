// `removeStudioWorkspace` teardown, lost-entry healing, exact-path fallback,
// multi-instance studios — the TEARDOWN half of orca-registry.test.ts (split
// per docs/maintainability/plans/2026-10-15-s45f3-orca-registry-split-916.md,
// issue #916, sweep-45 F3): teardown and its printed lines, salvage inventory,
// #175 healing by PATH, #193 exact-path fallback, #297 multi-instance naming.
// The registry-races/rows half (locks, row titles, `fleet ls` ROW column,
// ranking, partial answers, pair functions, findAttachHandle) lives in
// orca-registry-rows.test.ts.
//
// bun:test lane, not the workerd lane: this is CLI code (Bun.which, Bun.spawn,
// process env), and vitest-pool-workers cannot host any of it. Every orca
// invocation is INJECTED, so no test here ever shells out to real Orca — the
// tests that do spawn processes (the 8-process registry race, the registry
// writer scripts) write real files under temp dirs only.
import { test, describe, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeWorkspaceRemoval,
  removeStudioWorkspace,
  readStudioRows,
  ensureStudioWorkspace,
  findAttachHandle,
  type WorkspaceRegistry,
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


