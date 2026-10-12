# One guarded studio-row decoder behind the CLI casts (refs #436)

Sweep-10 F1 (docs/maintainability/2026-10-12-type-safety-sweep-10.md). Tier GLM-OK, bounded. Pure code, two-way door, no new dependency.

## Problem
Every CLI read of a /studio/ route trusts the response shape with a bare cast, zero runtime check (21 sites). A Worker older/newer than the CLI during a deploy window answers a different row shape; `state` reads undefined and downstream branches silently. Worst: cli/fleet.ts:2425 destroy-race reads `state === "stopped"` off an unvalidated cast to pick destroy-vs-refuse.

## Change
1. New `apps/fleet/cli/studio-row.ts`, import-free (only `import type` from ../src/studio/types):
   - `STUDIO_STATES: readonly StudioState[]` = the 4 states
   - `parseStudioStatus(raw: unknown): StudioStatus | null` — typeof-check `id` (string), `state` ∈ STUDIO_STATES, `error` is string|null. Null on any miss, never throws.
   - `parseStudioStatusArray(raw: unknown): StudioStatus[] | null` — array where every element decodes; null otherwise (listing routes).
   - Why these 3 fields: they are what the CLI branches on (state/error everywhere, id at spawn/provision print paths).
2. RED first: `apps/fleet/test/cli.studio-row.test.ts` unit table — valid row decodes to same reference; wrong state value → null; missing id → null; error wrong type → null; non-object/array/null → null; valid array → deep-equal; array with one bad row → null. Run, watch fail (module absent), commit, push.
3. Wire sites, each calls the decoder and fails with a named error on null (tagged-result shape readStatus already established):
   - cli/status-poll.ts:45 — readStatus: `{ ok: false, why: "status body was not a studio row" }` on null
   - cli/destroy-outcome.ts:151 — requestDestroy ok branch: kind "http-error"-style failure line `destroy answered 200 but the body was not a studio row`, teardown false, exit 1
   - cli/recycle-outcome.ts:195 — same shape as destroy: `recycle answered 200 but the body was not a studio row`, exit 1
   - cli/ff.ts:106 (list), :118 (fetchStatus → null on bad shape, matches its own null-on-failure contract), :210 (spawn id read → fail with named error)
   - cli/fleet.ts: 692 (cmdCheck — stderr named error + exit 1), 730 (cmdClearSessionGuard same), 853 (refreshAll — return `s` the previous row on bad shape, same catch branch), 875 (cmdLs — named error + exit 1), 1130 (cmdTabs listStudios — throw named error, caught by its own catch), 1177 (onboardListStudios — throw named error, caught in cmdOnboard), 1317 (cmdSpawn), 1378 (cmdProvision) — stderr/throw + exit per each site's existing failure convention, 1431 (cmdRecycle report.status — narrow with decoder before treating as StudioStatus; on null skip the Orca row work, keep printing report lines), 2382 (reap listStudios — throw "studio listing was not studio rows", its caller already treats a throw as unknown-reap), 2425 (destroy race — decoder null → race stays null, i.e. same as unreadable row)
   - src/studio/registry.ts:382 — getStudioRowLookup: JSON.parse inside try, then decoder null → kind "malformed" (same log line). :434 — listStudios per-row: decoder null → same skip-and-log catch path.
   - Array sites use parseStudioStatusArray; single-row sites parseStudioStatus.
4. Optional follow-ons NOT in this PR (issue lists them): fleet.ts:2589, accounts.ts, junior.ts, orca-workspace.ts, backoff.ts, diag.ts, repair-failure.ts, open-prs route.

## Boundaries
- ~60 changed lines target, one PR.
- Existing test/cli.* suites must stay byte-identical green — they inject fetchImpl with real shapes, so a real shape must keep flowing through the decoder.
- Heavy gates: `bun run check` (full tsc across 5 tsconfigs) and `bun run english-check` — run ONCE at the end, one at a time, never alongside a test run. Targeted suites: the decoder test + every cli suite whose file this PR touches (cli.destroy-outcome, cli.recycle-outcome, cli.fleet, cli.diag, studio.destroy-race, studio.registry, studio.ff).
- Two-way door: pure code.

## Check
cd apps/fleet && bun test test/cli.studio-row.test.ts (new), then each touched suite, then `bun run check`, `bun run english-check` — each exit 0.

## Steps
1. RED decoder test → commit → push (branch sweep-429-type-safety-glm... create it: `git checkout -b studio-row-decoder-436`)
2. Implement cli/studio-row.ts → green → commit → push
3. Wire all sites → touched suites green → commit → push
4. check + english-check → commit any fixes → push
