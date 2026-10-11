# Drop test-only export WATCH_INTERVAL_MS — board #407

**Goal:** Remove the `export` keyword on `WATCH_INTERVAL_MS` in apps/fleet/cli/accounts.ts:348; keep the const and its doc comment module-private. No behavior change.

**Architecture:** Sweep-5 finding F10 (issue #407, parent sweep #394, doc docs/maintainability/2026-10-11-deep-modules-sweep-5.md). The const's own comment says it is clamped deliberately; the export exists for no production consumer — test/bun/accounts-cli.test.ts never imports it (verified: only comment mentions at test lines 531, 569, zero `import` of the symbol). Sweep-1 culture (#357): a test-only export dies, the module keeps the value private. No test change needed — the test's comments reference the name only.

**Tech Stack:** TypeScript (cli tsconfig project); verification via bun test + tsc.

**Spec:** https://github.com/rafarc21/fleetflare/issues/407 — the issue body IS the spec.

## Constraints
- GLM-OK tier: constant visibility, no behavior, no auth/credentials touched.
- All repo content English.
- Two-way door: pure code, 1 changed line.

## Steps
1. Edit apps/fleet/cli/accounts.ts:348 — `export const WATCH_INTERVAL_MS = 60_000;` becomes `const WATCH_INTERVAL_MS = 60_000;`. Nothing else in the file moves; the doc comment above it stays verbatim.
2. Run from apps/fleet: `bun test test/bun/accounts-cli.test.ts` — ALL PASS.
3. Gates, one at a time (flock): from apps/fleet `flock /tmp/fleet-gate.lock bun run check` exit 0, then `flock /tmp/fleet-gate.lock bun run english-check` exit 0.
4. Commit `refactor(fleet): drop test-only export WATCH_INTERVAL_MS (refs #407)`, push `LEFTHOOK=0 git push -u origin fix-407-drop-watch-interval-export`, then write /workspace/.fleet/done/407.json per the standard shape with REAL output tails from step 2-3.
