# StudioStatus row builder — test fixture extraction (refs #372)

Sweep-3 S3-F2 (docs/maintainability/2026-10-11-test-sweep-3.md). Tier GLM-OK, scope-conservative. Behavior-preserving fixture extraction only — no src/ change.

## Problem
The 9-field StudioStatus null literal `{ id, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...overrides }` is hand-written as local `row()` builders across test files. Defaults differ only in `id` and `state`.

## Change
1. New `apps/fleet/test/helpers/studio-row.ts`:
   - `row(overrides: Partial<StudioStatus> = {})` → `{ id: "acme-os--maestro", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...overrides }`
   - `runningRow(o)` = `row({ state: "running", ...o })`, `stoppedRow(o)` = `row({ state: "stopped", ...o })`.
   - Pure TS, no Bun/DOM APIs — it compiles under both the root workers-types project and the test/ bun-types project (both root it).
2. RED first: `apps/fleet/test/studio-row.helper.test.ts` golden test — exact base shape of `row()`, `runningRow`/`stoppedRow` set state, overrides win. Run it, watch it fail on the missing module, commit.
3. Implement helper, test green. Then migrate 9 files, one commit each, each file's suite green before the next:
   - test/bun/fleet-ls-state.test.ts (defaults match helper base exactly)
   - test/bun/fleet-ls-denominator.test.ts (runningRow)
   - test/bun/fleet-ls-account.test.ts (runningRow, id "demosite-life--pilot")
   - test/bun/fleet-ls-restarts.test.ts (runningRow, keeps its observed/restarts logic)
   - test/bun/fleet-ls-wip.test.ts (runningRow, keeps its observed/wipSyncedAt logic)
   - test/bun/fleet-ls-footer.test.ts (raw literal → runningRow)
   - test/studio.repo.test.ts (runningRow, id "websites--pilot")
   - test/studio.start-gate-writeback.test.ts (base row + `{ id: ID, state }`)
   - test/board.leak.test.ts (runningRow + id MINE / spawnTokenHash / repoSlug)
   Migration rule: where a file's old defaults differ from the helper's, pass them as overrides — a one-line local wrapper or call-site override is fine; NEVER re-spell the 9-null literal. Call sites stay untouched where an import alias suffices.
4. Carved OUT (Claude lane, local builders stay): test/creds.route.test.ts, test/write-proxy.gh-route.test.ts — credentials-route tests. PR notes them as residue.

## Boundaries
- No behavior change: every migrated file keeps its exact id/state/hash values.
- Heavy gates: full `bun run test` (flock /tmp/fleet-gate.lock) ONCE at the very end; `bun run check` ONCE at the end; per-file runs are targeted and cheap.
- No UI change → QA is suites + tsc, not browser.

## Check
Per-file during migration: `cd apps/fleet && bun test test/bun/<file>` (bun lane) or `bun run vitest run test/<file>` (vitest lane). End: flock full test, check, english-check, test-lies-check, `bun run bun-test`.
