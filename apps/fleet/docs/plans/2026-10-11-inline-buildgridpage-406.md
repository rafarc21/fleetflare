# Inline buildGridPage pass-through — board #406

**Goal:** Inline the 3-line `buildGridPage()` pass-through in apps/fleet/scripts/build-page.ts into main's grid half; no behavior change.

**Architecture:** Pure deletion-test refactor (sweep-5 finding F9, ride-along of sweep-2 D12). `buildGridPage()` (apps/fleet/scripts/build-page.ts:103-105) only wraps one `readFile` of page/grid.template.html and has exactly one caller (main, :117). Delete the function, move its doc comment to the call site, keep `assertNoSourceMappingUrl(gridHtml, "grid.html")` untouched. Nothing else in the file moves. Issue #406, parent sweep #394, doc docs/maintainability/2026-10-11-deep-modules-sweep-5.md.

**Tech Stack:** TypeScript bun script; no unit tests for this script — characterization is artifact byte-identity plus tsc.

**Spec:** https://github.com/rafarc21/fleetflare/issues/406 — the issue body IS the spec.

## Constraints
- GLM-OK tier: build-artifact plumbing, no deploy execution, no auth or credentials.
- All repo content English.
- Byte-identical outputs: `git diff` on apps/fleet/page/*.html empty after rebuild, both before and after the edit.
- Two-way door: pure code, ~6 changed lines.

## Steps
1. Baseline: `cd apps/fleet && bun run build:page`, then `git status --short apps/fleet/page/` — must be empty (main's artifacts current).
2. In apps/fleet/scripts/build-page.ts delete the `buildGridPage` doc comment + function (lines 96-105). At the main() call site replace `const gridHtml = await buildGridPage();` with the moved comment plus `const gridHtml = await readFile(path.join(PAGE_DIR, "grid.template.html"), "utf8");`.
3. Rebuild: `bun run build:page` again, `git status --short apps/fleet/page/` empty again.
4. Gates: `flock /tmp/fleet-gate.lock bun run check` (run from apps/fleet) exit 0; then `bun run english-check` exit 0. One heavy gate at a time — check first, english-check after.
5. Commit both-file changes if any, push with `LEFTHOOK=0 git push -u origin fix-406-inline-buildgridpage`, then write /workspace/.fleet/done/406.json per the shape below with REAL output tails from step 4.
