# Sweep 18 F9: adopt helpers/studio-row.ts row() in 9 GLM-OK files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 9 GLM-OK `status(overrides)` builders to `helpers/studio-row.ts` `row()` (adoption gap, helper exists from #372), add a `burnRow` export for the co-traveling Burn literal, zero test-behavior edits.

**Spec:** board issue https://github.com/rafarc21/fleetflare/issues/596, census finding F9 in `docs/maintainability/2026-10-12-test-helpers-sweep-18.md`. The 11 CLAUDE-ONLY files are out of scope, never touched here.

**Architecture:** `helpers/studio-row.ts` exports `row(overrides)` (defaults id "acme-os--maestro", state "stopped", 11 fields). Per the helper's own header contract, callers whose old builder differed pass their own id/state as overrides. Two co-traveling local conventions stay local: grid's `lastRefresh` pin, and burn-window-expiry's `readiness: null` (12th field, per-file wrapper keeps it).

**burnRow design:** `burnRow(overrides)` with all-zero defaults and `window5hStart` as REQUIRED override (no default) — the two call sites genuinely diverge (grid: `new Date().toISOString()` issue #181; cli.fleet: frozen `"2026-08-16T00:00:00.000Z"`), so the helper must not pick a winner. Type it `{ window5hStart: string } & Partial<Burn>` so a call without the key is a type error.

## Global Constraints

- Zero test-behavior edits: same fixture bytes out of every builder call, same assertions, same test bodies.
- The 9 files: `test/studio.burn.test.ts`, `test/studio.burn-window-expiry.test.ts`, `test/cli.fleet.test.ts`, `test/studio.do.test.ts` (TWO builders, outer :30 + nested :238), `test/studio.fleet-resume.test.ts`, `test/studio.grid.test.ts`, `test/studio.observation-tick.test.ts`, `test/studio.readiness.test.ts`, `test/studio.spawn-atomic.test.ts`.
- Wrappers keep file-local names (`status`, `burn`) so call sites stay untouched — only builder bodies change.
- Wrapper shape per file: `const status = (o: Partial<StudioStatus> = {}) => row({ <defaults>, ...o });` where `<defaults>` is that file's id/state etc. as overrides on row()'s census defaults.
- Files needing fields beyond row()'s 11 (burn-window-expiry: `readiness: null`) add them in their local wrapper, NOT in row() — row()'s 11-field default set is frozen (11 existing importers depend on it).
- Fleet-resume's extra defaults (`spawnedBy: "operator"`, `repoSlug`, `parked: true`, `stoppedAt`) go in its local wrapper as overrides.
- grid's `card()` literals at :274/:368 are GridCard shapes, not StudioStatus builders — NOT touched.
- All repository content English. Conventional Commits, `refs #596` trailer.
- Run only the touched tests; heavy gates one at a time under `flock /tmp/fleet-gate.lock`.
- Baseline BEFORE any edit: vitest run on the 9 files, record per-file pass/fail counts, reproduce exactly after.

---

### Task 1: burnRow export + pinned unit test (TDD)

**Files:** Modify `apps/fleet/test/helpers/studio-row.ts`, extend `apps/fleet/test/studio-row.helper.test.ts`.

- [ ] **Step 1: RED.** Add a `describe("burnRow", ...)` block to `test/studio-row.helper.test.ts`: (a) `burnRow({ window5hStart: "2026-08-16T00:00:00.000Z" })` equals `{ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 0 }`; (b) `// @ts-expect-error` on a call WITHOUT `window5hStart` (must fail to compile without it); (c) `burnRow({ window5hStart: "x", turns: 7 })` overrides turns. Run `cd apps/fleet && bun run vitest run test/studio-row.helper.test.ts` → RED (burnRow not exported).
- [ ] **Step 2: GREEN.** In `test/helpers/studio-row.ts` add `import type { Burn } from "../../src/studio/burn";` and:

```typescript
// Sweep-18 F9 (#596): the zero Burn literal that co-travels with row().
// window5hStart has NO default — the two adopting sites genuinely diverge
// (grid: now per issue #181; cli.fleet: frozen 2026-08-16), so each caller
// pins its own; a call without it is a type error, not a silent zero.
export function burnRow(o: { window5hStart: string } & Partial<Burn> = {} as never): Burn {
  return { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hOutput: 0, ...o };
}
```

If the default `= {} as never` spelling fights the type (window5hStart required but default absent), drop the default entirely — every caller passes at least window5hStart anyway. Run helper test → GREEN.
- [ ] **Step 3:** Commit `test(fleet): studio-row helper exports burnRow, window5hStart required (refs #596)`, push with `LEFTHOOK=0 git push origin test-596-studio-row-adoption`.

### Task 2: migrate the 9 files' status() builders to row()

Per-file wrapper body (name `status` kept, call sites untouched). All 9 delete their local 11-null literal and import `row` (and `burnRow` where noted) from `./helpers/studio-row` (all sit in `apps/fleet/test/`, so `./helpers/studio-row` resolves):

- [ ] `test/studio.burn.test.ts` (:1197): `const status = (o: Partial<StudioStatus> = {}) => row({ id: STUDIO_ID, state: "running", ...o });`
- [ ] `test/studio.burn-window-expiry.test.ts` (:60): `row({ id: STOPPED_ID, state: "stopped", readiness: null, ...o })` — readiness stays in the local wrapper. Keep local `liveBurn()` untouched (divergent seeded values, NOT the co-traveling zero literal).
- [ ] `test/cli.fleet.test.ts` (:39): `row({ id: "websites--pilot", state: "running", ...o })`; fold local `burn()` (:31) to `const burn = (o: Partial<Burn> = {}) => burnRow({ window5hStart: "2026-08-16T00:00:00.000Z", ...o });`
- [ ] `test/studio.do.test.ts` (:30 AND :238 — two wrappers, same body): `row({ id: "websites--pilot", state: "running", ...o })`.
- [ ] `test/studio.fleet-resume.test.ts` (:23): `row({ id: "websites--web-studio--5", state: "stopped", spawnedBy: "operator", repoSlug: REPO_SLUG, parked: true, stoppedAt: "2026-09-01T00:00:00.000Z", ...o })` — keep the "Review round 1" comment attached to the wrapper.
- [ ] `test/studio.grid.test.ts` (:23): `row({ id: STUDIO_ID, state: "running", lastRefresh: "2026-08-16T00:00:00.000Z", ...o })` — lastRefresh pin stays local, the #181 comment stays on the burn fold: `const burn = (o: Partial<Burn> = {}) => burnRow({ window5hStart: new Date().toISOString(), ...o });`
- [ ] `test/studio.observation-tick.test.ts` (:82): `row({ id: "websites--pilot", state: "running", ...o });`
- [ ] `test/studio.readiness.test.ts` (:27): `row({ id: STUDIO_ID, state: "running", ...o });`
- [ ] `test/studio.spawn-atomic.test.ts` (:22): `row({ id: "websites--release", state: "running", ...o });`
- [ ] **Verify:** per-file vitest run on all 9, counts identical to baseline. Commit `test(fleet): fold 9 GLM-OK status() builders onto studio-row row() (refs #596)`, push.

### Task 3: full verification + completion record

- [ ] Combined vitest run on the 9 files + `test/studio-row.helper.test.ts`. Counts match baseline, helper suite green.
- [ ] `flock /tmp/fleet-gate.lock bun run check` (alone) → exit 0.
- [ ] `bun run scripts/english-check.ts` → clean.
- [ ] `bun run scripts/test-lies-check.ts` → 0/0/0.
- [ ] Completion record `/workspace/.fleet/done/596.json` (outside repo, never committed), `issue` field `https://github.com/rafarc21/fleetflare/issues/596`.
- [ ] Confirm `git log origin/main..origin/test-596-studio-row-adoption` non-empty, all commits pushed.
