# S36-F2+F3 — un-export NsStub and ShResult (refs #813)

Ref #739 sweep 36, findings F2+F3. Census doc: docs/maintainability/2026-10-13-unused-test-helpers-sweep-36.md. Class: sweep-24 F9 Intercept precedent — convenience type exports nobody took; the type flows to callers through function signatures (nsWith/envWithNs, sh), so the export keyword is dead surface.

## Census (2026-10-14, verified by grep in this studio)

- `grep -rn "NsStub" --include="*.ts" apps/fleet --exclude-dir=node_modules` → only fake-namespace.ts:14 (declaration), :20, :30 (its own signatures). The 6 suite importers (grid, burn-window-expiry, fleet-resume, profile, paste, index) import nsWith/envWithNs only.
- `grep -rn "ShResult" --include="*.ts" apps/fleet --exclude-dir=node_modules` → only shell.ts:1 (declaration), :8 (return type of sh()). The 3 suite importers (memory-migrate, memory-clone, localci-run) import sh only.

## Change

Two one-line keyword drops, one commit:

- fake-namespace.ts:14 — `export type NsStub ...` → `type NsStub ...`. Type stays for the module's own two signatures.
- shell.ts:1 — `export type ShResult ...` → `type ShResult ...`. Type stays as sh()'s return type.

No test behavior changes. No test file edits. No import edits anywhere — zero importers.

## Verification

No runtime behavior changes — the dropped keywords are compile-time only, and the census greps show zero importers. There is no meaningful RED/GREEN mutation pair to run: the RED case for "an importer still existed" is exactly what `bun run check` detects, so one GREEN run of the check is the proof. That single heavy gate runs once, alone, under `flock /tmp/fleet-gate.lock`.

1. `cd apps/fleet && bun run check` — tsc across all five tsconfigs. Fails if any hidden importer of either type existed; green = none did. The one heavy gate.
2. `cd apps/fleet && bun run english-check` — cheap, not a gate.
3. `cd apps/fleet && bun run test-lies-check` — cheap, not a gate.
4. `cd apps/fleet && bun test test/bun/memory-migrate.test.ts test/bun/memory-clone.test.ts test/bun/localci-run.test.ts` — shell.ts's three sh() importers; proves zero behavior change on the bun lane.
5. `cd apps/fleet && bunx vitest run test/studio.grid.test.ts test/studio.burn-window-expiry.test.ts test/studio.fleet-resume.test.ts test/studio.profile.test.ts test/studio.paste.test.ts test/index.test.ts` — fake-namespace.ts's six nsWith/envWithNs importers on the vitest lane. Run alone, never alongside another gate.

Baseline: `bun run check` is green on origin/main (last full run in the #851/#848 merge chain); this branch must match it.
