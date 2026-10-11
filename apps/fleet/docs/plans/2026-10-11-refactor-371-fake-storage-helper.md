# #371 — Shared fakeStorage test helper

**Goal:** One `apps/fleet/test/helpers/do-storage.ts` exporting a Map-backed
DO-storage fake; migrate 8 named suites to it, builder swap only.

**Spec:** https://github.com/rafarc21/fleetflare/issues/371
(sweep-3 S3-F1: docs/maintainability/2026-10-11-test-sweep-3.md)

**Architecture:** helper returns `{ map, get, put }` — `get` returns exactly
what was put (stored null stays null, the #103 lesson self-heal.test.ts:122
documents), `put` single-key form only. Per-file extras (multi-key put,
putKeys/failNextPutFor, typed unions) stay local per the issue's carve-out.
Each migrated suite keeps passing byte-identical test bodies.

**In scope (8):** wake-gate, stopped-stays-stopped, readiness, self-heal,
observed, sweep, transcript, restart-count — all under apps/fleet/test/.

**Explicitly OUT (named by issue, Claude lane):** account-failover,
account-by-repo, routes, spawn, refresh, provision, parked-auto-resume,
failover-274, auto-continue, account-launched, replacement,
worktree-session, backup-guard, account-unmapped, observation,
observation-tick.
**Also left out, to note in PR:** grid (27 hot grep hits), do + directus.provision
(1 hot hit each — "when in doubt, leave out"), bun/transcript-wire-equivalence
(put deliberately a no-op there; helper would change semantics).

## Steps

1. RED: add test/helpers/do-storage.test.ts pinning helper contract
   (seed writes, null round-trip, put-then-get, map exposure). Runs RED
   (module absent) via vitest before helper exists.
2. GREEN: create test/helpers/do-storage.ts exporting
   `fakeStorage(seed?: Record<string, unknown>)` →
   `{ map: Map<string, unknown>; get; put }`.
3. Migrate 8 suites file-by-file, one commit each: delete local builder,
   import helper, keep local per-file extras. No test-body edits.
4. Per file: run its vitest lane after the swap (see Verification).
5. Final: bun run check (single heavy gate), english-check, PR.

## Verification (per migrated file)

`./node_modules/.bin/vitest run test/<file>` per suite from apps/fleet/ —
pass count must equal the pre-migration count (record both).
Heavy gates (bun run check) run ONCE at the end, never in parallel.
