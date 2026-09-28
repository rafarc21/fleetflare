// Issue #251: `fleet rescue-all [--repo R] [--dry-run]` — the pre-image-deploy
// gate. This suite covers the fix's testable core, `runRescueAll`
// (cli/fleet.ts): running-only selection (never a stopped studio, per #113
// F1 — an exec into one would start it), `--repo` scope, `--dry-run`'s
// report-only branch, per-studio "clean"/"rescued"/"FAILED" reporting, and
// the non-zero exit code a pre-deploy script can gate on.
//
// bun:test lane (CLI code, same reason fleet-tabs-scope.test.ts's own header
// gives). Every exec is injected through a fake `rescueStudio` — never a real
// studio/container.
import { test, expect } from "bun:test";
import {
  runRescueAll, RESCUE_ALL_CONCURRENCY_LIMIT, type RescueAllDeps, type RescueAllFlags, type RescueAllOutcome,
} from "../../cli/fleet";
import type { StudioStatus } from "../../src/studio/types";

function studio(id: string, state: StudioStatus["state"] = "running"): StudioStatus {
  return { id, state } as StudioStatus;
}

function flags(over: Partial<RescueAllFlags> = {}): RescueAllFlags {
  return { repo: null, dryRun: false, ...over };
}

function fakeDeps(over: {
  studios?: StudioStatus[];
  rescueStudio?: (id: string) => Promise<RescueAllOutcome>;
} = {}): { deps: RescueAllDeps; lines: string[]; rescueCalls: string[] } {
  const lines: string[] = [];
  const rescueCalls: string[] = [];
  const deps: RescueAllDeps = {
    listStudios: async () => over.studios ?? [],
    rescueStudio: async (id: string) => {
      rescueCalls.push(id);
      return over.rescueStudio ? over.rescueStudio(id) : { ok: true, pushes: [] };
    },
    log: (line: string) => lines.push(line),
  };
  return { deps, lines, rescueCalls };
}

// ---------------------------------------------------------------------------
// A stopped studio: never exec'd against at all.

test("a stopped studio is never exec'd against, and is printed as skipped with its state", async () => {
  const { deps, rescueCalls, lines } = fakeDeps({
    studios: [studio("websites--maestro", "stopped"), studio("websites--pilot", "running")],
  });

  const result = await runRescueAll(flags(), deps);

  expect(rescueCalls).toEqual(["websites--pilot"]);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--maestro") && l.includes("stopped"))).toBe(true);
  expect(result.exitCode).toBe(0);
});

// PR #263 round 2, C6: a DEGRADED studio still runs a container that can
// hold real work (a failed refresh, a failed restart, a failover — the
// rollout that eventually replaces it never runs rescue at all), so it must
// be exec'd exactly like "running". Only "stopped" and "provisioning" never
// run a container an exec could reach, so only those are skipped.
test("degraded studios ARE exec'd; only stopped/provisioning are skipped, each printed with its state", async () => {
  const { deps, rescueCalls, lines } = fakeDeps({
    studios: [
      studio("websites--a", "provisioning"),
      studio("websites--b", "degraded"),
      studio("websites--c", "running"),
      studio("websites--d", "stopped"),
    ],
  });
  await runRescueAll(flags(), deps);
  expect(rescueCalls.sort()).toEqual(["websites--b", "websites--c"]);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--a") && l.includes("provisioning"))).toBe(true);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--d") && l.includes("stopped"))).toBe(true);
  expect(lines.some((l) => l.includes("websites--b") && l.includes("skipped"))).toBe(false);
});

test("--dry-run also prints skipped rows for stopped/provisioning studios", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--a", "provisioning"), studio("websites--b", "degraded")],
  });
  await runRescueAll(flags({ dryRun: true }), deps);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--a") && l.includes("provisioning"))).toBe(true);
  expect(lines.some((l) => l.includes("would rescue") && l.includes("websites--b"))).toBe(true);
});

// A registry state of "running"/"degraded" can still be stale: the DO's own
// `ctx.container.running` gate (do.ts, unchanged by this fix) answers
// { ok: false, error: "not running" } without ever exec'ing. That must be
// reported as a skip, never counted as a failed rescue attempt.
test("the DO reporting 'not running' (registry stale) is skipped, not counted as a failure", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--a")],
    rescueStudio: async () => ({ ok: false, error: "not running" }),
  });
  const result = await runRescueAll(flags(), deps);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--a") && /container not running/.test(l))).toBe(true);
  expect(lines.some((l) => /FAILED/.test(l))).toBe(false);
  expect(result.exitCode).toBe(0);
});

test("a genuine rescue failure (not 'not running') still fails the whole run", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--a")],
    rescueStudio: async () => ({ ok: false, error: "push rejected" }),
  });
  const result = await runRescueAll(flags(), deps);
  expect(lines.some((l) => /FAILED/.test(l) && l.includes("push rejected"))).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

// ---------------------------------------------------------------------------
// --repo scope.

test("--repo scopes to one repo's running studios only", async () => {
  const { deps, rescueCalls } = fakeDeps({
    studios: [
      studio("websites--maestro"),
      studio("websites--pilot"),
      studio("acme-os--maestro"),
    ],
  });
  await runRescueAll(flags({ repo: "some-org/websites" }), deps);
  expect(rescueCalls.sort()).toEqual(["websites--maestro", "websites--pilot"]);
});

// ---------------------------------------------------------------------------
// --dry-run: lists, never execs.

test("--dry-run lists which studios WOULD be rescued without execing anything", async () => {
  const { deps, rescueCalls, lines } = fakeDeps({
    studios: [studio("websites--maestro"), studio("websites--scratch", "stopped")],
  });

  const result = await runRescueAll(flags({ dryRun: true }), deps);

  expect(rescueCalls).toEqual([]);
  expect(lines.some((l) => l.includes("would rescue") && l.includes("websites--maestro"))).toBe(true);
  expect(lines.some((l) => l.includes("skipped") && l.includes("websites--scratch") && l.includes("stopped"))).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("--dry-run with nothing running says so and still exits 0", async () => {
  const { deps, rescueCalls, lines } = fakeDeps({ studios: [studio("websites--scratch", "stopped")] });
  const result = await runRescueAll(flags({ dryRun: true }), deps);
  expect(rescueCalls).toEqual([]);
  expect(lines.some((l) => /no running studios/i.test(l))).toBe(true);
  expect(result.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// Per-studio reporting: clean vs rescued vs failed.

test("a clean studio (nothing to rescue) is reported, not silently skipped", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--pilot")],
    rescueStudio: async () => ({ ok: true, pushes: [] }),
  });
  const result = await runRescueAll(flags(), deps);
  expect(lines.some((l) => l.includes("websites--pilot") && /nothing to rescue/i.test(l))).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("a rescued studio's refs (main checkout AND member worktrees) are all printed", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--pilot")],
    rescueStudio: async () => ({
      ok: true,
      pushes: [
        { branch: "fleet/rescue/websites--pilot-20260925060000", files: 2, kind: "files" },
        { branch: "fleet/rescue/websites--pilot/wt/agent-a1-20260925060000", files: 1, kind: "commits" },
      ],
    }),
  });
  const result = await runRescueAll(flags(), deps);
  expect(lines.some((l) => l.includes("fleet/rescue/websites--pilot-20260925060000"))).toBe(true);
  expect(lines.some((l) => l.includes("fleet/rescue/websites--pilot/wt/agent-a1-20260925060000"))).toBe(true);
  expect(result.exitCode).toBe(0);
});

// Issue #266: the count's label (files vs commits) must follow the wire
// format's own `kind` field, never a hardcoded "files" — a clean-but-
// unpushed-commits rescue must never be printed as if it were files.
test("a push's count is labeled with its own kind — 'files' for a dirty-tree rescue, 'commits' for a clean-but-unpushed one", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--pilot")],
    rescueStudio: async () => ({
      ok: true,
      pushes: [
        { branch: "task/feature", files: 3, kind: "files" },
        { branch: "fleet/rescue/websites--pilot/20260925060000/checkout/feat", files: 2, kind: "commits" },
      ],
    }),
  });
  await runRescueAll(flags(), deps);
  expect(lines.some((l) => l.includes("task/feature") && l.includes("3 files"))).toBe(true);
  expect(lines.some((l) => l.includes("checkout/feat") && l.includes("2 commits"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Exit code: non-zero if ANY studio's rescue attempt failed — scriptable as
// a pre-deploy gate, per the issue's own stated use case.

test("any studio's rescue failing makes the whole run exit non-zero, but every other studio still runs", async () => {
  const { deps, rescueCalls, lines } = fakeDeps({
    studios: [studio("websites--a"), studio("websites--b")],
    rescueStudio: async (id) => (id === "websites--a" ? { ok: false, error: "push rejected" } : { ok: true, pushes: [] }),
  });
  const result = await runRescueAll(flags(), deps);
  expect(rescueCalls.sort()).toEqual(["websites--a", "websites--b"]);
  expect(lines.some((l) => l.includes("websites--a") && /FAILED/.test(l) && l.includes("push rejected"))).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

test("the exec itself throwing is caught and counted as a failure, not an unhandled rejection", async () => {
  const { deps } = fakeDeps({
    studios: [studio("websites--a")],
    rescueStudio: async () => { throw new Error("network exploded"); },
  });
  const result = await runRescueAll(flags(), deps);
  expect(result.exitCode).not.toBe(0);
});

test("an all-clean fleet exits 0", async () => {
  const { deps } = fakeDeps({ studios: [studio("websites--a"), studio("websites--b")] });
  const result = await runRescueAll(flags(), deps);
  expect(result.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// Board issue #359, measured live 2026-09-26: a single `rescue-all` over 8
// studios ran >15 minutes with no progress output, and 4/5 busy acme-life
// studios failed "the operation timed out". Root cause 1: `runRescueAll` was
// fully sequential (`for (const s of targets) { await deps.rescueStudio(...) }`)
// — one slow studio delays every studio after it in the list, and a run's
// total wall time is the SUM of every studio's own duration, not the max.

test("studios are rescued IN PARALLEL — total wall time tracks the slowest single studio, not the sum of all of them", async () => {
  const { deps } = fakeDeps({
    studios: [studio("websites--a"), studio("websites--b"), studio("websites--c")],
    rescueStudio: async (id) => {
      const delay = id === "websites--b" ? 150 : 80;
      await new Promise((r) => setTimeout(r, delay));
      return { ok: true, pushes: [] };
    },
  });
  const start = Date.now();
  await runRescueAll(flags(), deps);
  const elapsed = Date.now() - start;
  // Sequential (80+150+80=310ms, any order) would comfortably clear 250ms;
  // parallel finishes close to the slowest one (150ms) plus scheduling slack.
  expect(elapsed).toBeLessThan(250);
});

// ---------------------------------------------------------------------------
// Root cause 2: no per-studio client-side timeout — a `rescueStudio` call
// that never resolves (a genuinely hung exec, or a network stall the server
// never answers) hung the whole sequential loop forever, bounded only by
// whatever the server's own exec deadline eventually enforced, invisible to
// the CLI itself. A studio whose own budget is exceeded must be reported as
// a TIMEOUT (distinct from a genuine FAILED), and must never block any OTHER
// studio's own rescue.

test("a studio whose rescueStudio call never resolves is reported as TIMEOUT, not FAILED, and never blocks the other studios", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--stuck"), studio("websites--ok")],
    rescueStudio: (id) => (id === "websites--stuck" ? new Promise(() => {}) : Promise.resolve({ ok: true, pushes: [] })),
  });
  const result = await runRescueAll(flags({ timeoutMs: 40 }), deps);
  expect(lines.some((l) => l.includes("websites--ok") && /nothing to rescue/i.test(l))).toBe(true);
  expect(lines.some((l) => /TIMEOUT/.test(l) && l.includes("websites--stuck"))).toBe(true);
  expect(lines.some((l) => /FAILED/.test(l) && l.includes("websites--stuck"))).toBe(false);
  expect(result.exitCode).not.toBe(0);
});

test("a per-studio timeout that fires before any response names that honestly — never fabricates a step name it never received", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--stuck")],
    rescueStudio: () => new Promise(() => {}),
  });
  await runRescueAll(flags({ timeoutMs: 30 }), deps);
  const line = lines.find((l) => /TIMEOUT/.test(l) && l.includes("websites--stuck"));
  expect(line).toBeDefined();
  expect(line).toMatch(/waiting for a response/i);
  // Must not claim to know which rescue.ts step failed — no response ever came.
  expect(line).not.toMatch(/checkout|finalize|status|add|commit|push\)/);
});

// ---------------------------------------------------------------------------
// Root cause 3: no progress output at all until a studio's own exec resolved
// — an operator watching a `rescue-all` run piped through `| tail` saw
// nothing for the whole run. A "rescuing <id>..." line must be logged the
// MOMENT each studio's rescue is dispatched, not only once its outcome is
// known, and the outcome line itself must name how long that studio took.

test("a 'rescuing <id>...' progress line is logged the moment a studio's rescue starts, before its outcome is known", async () => {
  let resolveOutcome!: (v: RescueAllOutcome) => void;
  const pending = new Promise<RescueAllOutcome>((r) => { resolveOutcome = r; });
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--a")],
    rescueStudio: () => pending,
  });

  const run = runRescueAll(flags(), deps);
  // Yield to the microtask queue so the dispatch's own synchronous "starting"
  // log has a chance to run, without ever resolving the studio's outcome.
  await Promise.resolve();
  await Promise.resolve();

  expect(lines.some((l) => /rescuing/i.test(l) && l.includes("websites--a"))).toBe(true);
  expect(lines.some((l) => /nothing to rescue/i.test(l))).toBe(false);

  resolveOutcome({ ok: true, pushes: [] });
  await run;
});

// Fresh review of PR #359 round 2, Finding 2: the test above only exercises a
// SINGLE target, so it cannot distinguish genuine concurrent dispatch (every
// "rescuing" line logged synchronously, before any target's own async work
// resolves) from a merely-sequential-but-still-eventually-logs-first-line
// implementation. With >=2 targets — one fast, one artificially slower — a
// dispatch that were secretly sequential would log the fast target's OUTCOME
// before ever reaching the slow target's "rescuing" line; genuine concurrent
// dispatch logs BOTH "rescuing" lines up front, before either outcome.
test("with multiple targets, ALL 'rescuing <id>...' lines are logged before ANY outcome line — proving concurrent dispatch, not a lucky single-target ordering", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--fast"), studio("websites--slow")],
    rescueStudio: async (id) => {
      await new Promise((r) => setTimeout(r, id === "websites--slow" ? 40 : 0));
      return { ok: true, pushes: [] };
    },
  });

  await runRescueAll(flags(), deps);

  const firstOutcomeIdx = lines.findIndex((l) => /nothing to rescue/i.test(l));
  const rescuingIdxs = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /rescuing/i.test(l))
    .map(({ i }) => i);
  expect(rescuingIdxs.length).toBe(2);
  expect(firstOutcomeIdx).toBeGreaterThan(-1);
  for (const idx of rescuingIdxs) expect(idx).toBeLessThan(firstOutcomeIdx);
});

test("a resolved studio's outcome line names how long that studio's own rescue took", async () => {
  const { deps, lines } = fakeDeps({
    studios: [studio("websites--a")],
    rescueStudio: async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, pushes: [] };
    },
  });
  await runRescueAll(flags(), deps);
  const line = lines.find((l) => l.includes("websites--a") && /nothing to rescue/i.test(l));
  expect(line).toBeDefined();
  expect(line).toMatch(/\d+(\.\d+)?s\)?\s*$/);
});

// ---------------------------------------------------------------------------
// Fresh review of PR #359 round 2, Finding 3: unbounded concurrency. The old
// `Promise.allSettled(targets.map(...))` dispatched EVERY target's exec/fetch
// at once, no cap — a fleet with many studios could open dozens of
// simultaneous rescue execs, each a real, resource-intensive server-side
// walk. `concurrency` (RescueAllFlags's own new test seam, mirroring
// `timeoutMs`) lets this test use a small number instead of the real
// production default (RESCUE_ALL_CONCURRENCY_LIMIT), so the assertion below
// is exact rather than a fragile timing race against the real default.

test("no more than `concurrency` targets' rescues are ever in flight at once", async () => {
  const CONCURRENCY = 3;
  const TARGET_COUNT = 8;
  let inFlight = 0;
  let peak = 0;
  const calledIds: string[] = [];
  const { deps } = fakeDeps({
    studios: Array.from({ length: TARGET_COUNT }, (_, i) => studio(`websites--${i}`)),
    rescueStudio: async (id) => {
      calledIds.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, pushes: [] };
    },
  });

  const result = await runRescueAll(flags({ concurrency: CONCURRENCY }), deps);

  expect(peak).toBeLessThanOrEqual(CONCURRENCY);
  expect(peak).toBeGreaterThan(1); // proves this is genuinely concurrent, not accidentally serialized
  expect(calledIds.sort()).toEqual(Array.from({ length: TARGET_COUNT }, (_, i) => `websites--${i}`).sort());
  expect(result.exitCode).toBe(0);
});

/**
 * Fresh review of PR #359 round 2, item 4: the test above always passes an
 * explicit `concurrency` override, so it proves nothing about the REAL
 * production default — a call site that forgot to wire `flags.concurrency`
 * through from CLI args, or a wrong literal, would leave every existing test
 * green. Production's own dispatch (`case "rescue-all"` in cli/fleet.ts)
 * never sets `flags.concurrency` at all, so this exercises the exact same
 * "no override" shape production hits.
 *
 * Two assertions, deliberately not referencing each other: `toBe(5)` is a
 * literal, hardcoded expectation (never `toBe(RESCUE_ALL_CONCURRENCY_LIMIT)`,
 * which would be tautological — always true regardless of what the constant
 * itself was accidentally changed to) that the exported constant IS 5, plus a
 * behavioral check (same fixture as the test above, but with NO `concurrency`
 * in flags) that dispatch is actually capped there when nothing overrides it.
 *
 * Bite-proof (2026-09-26): temporarily changed `RESCUE_ALL_CONCURRENCY_LIMIT`
 * to 1000 in cli/fleet.ts — both assertions went RED (`toBe(5)` received
 * 1000; `peak` measured 8, all targets dispatched at once, since 1000 never
 * actually caps 8 targets). Restored to 5, reconfirmed GREEN.
 */
test("the real production default concurrency is 5 (RESCUE_ALL_CONCURRENCY_LIMIT), not a placeholder that only doesn't matter because every other test passes an explicit override", async () => {
  expect(RESCUE_ALL_CONCURRENCY_LIMIT).toBe(5);

  const TARGET_COUNT = 8;
  let inFlight = 0;
  let peak = 0;
  const { deps } = fakeDeps({
    studios: Array.from({ length: TARGET_COUNT }, (_, i) => studio(`websites--${i}`)),
    rescueStudio: async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, pushes: [] };
    },
  });

  // No `concurrency` override — exercises the REAL production default.
  const result = await runRescueAll(flags(), deps);

  expect(peak).toBeLessThanOrEqual(5);
  expect(peak).toBeGreaterThan(1); // proves this is genuinely concurrent, not accidentally serialized
  expect(result.exitCode).toBe(0);
});
