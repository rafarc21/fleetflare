# S47-F6 orca-registry-rows — inject salvage destination, drop node:os mock (refs #967, refs #944, refs #715)

`apps/fleet/test/bun/orca-registry-rows.test.ts:1329-1339` redirects the salvage
destination by `mock.module("node:os")` — the repo's ONLY node:os mock. It
restores by spreading a captured `realOs` back in `finally`; a second node:os
mock in any other sharded file makes this `finally` restore `realOs` over that
file's mock (or this capture runs after an already-installed mock), silently
breaking its homedir redirect.

Production `removeStudioWorkspace` already takes an injected
`ContextSalvageDeps` (defaults to `join(homedir(), "fleet-teardown-salvage")`).
`closeStudioRow` does not forward one — add the seam.

## Change
- `apps/fleet/cli/orca-workspace.ts`: `closeStudioRow(id, deps, salvageDest =
  defaultSalvageDestination())`, forwarded to `removeStudioWorkspace`. No
  behavior change for the two existing callers (fleet.ts:1571, 2493).
- `apps/fleet/test/bun/orca-registry-rows.test.ts`: the "removed" test injects
  `tmpSalvageRoot()` and drops the `mock.module` block; delete the
  `import * as nodeOs` and the `mock` import from bun:test.

## Steps (TDD)
1. Plan doc commit + push.
2. RED: rewrite the "removed" test to pass `tmpSalvageRoot()` as 3rd arg —
   fails to compile (closeStudioRow takes 2 params).
3. GREEN: add the `salvageDest` param to `closeStudioRow`; test compiles,
   passes, no `mock.module` anywhere in the file.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/orca-registry-rows.test.ts` — all pass.
- `cd apps/fleet && npx tsc --noEmit -p cli && npx tsc --noEmit -p test` — exit 0.
- `cd apps/fleet && bun run english-check` — clean.

## Boundaries
- Two files only. No container/, src/. No closing keywords for #944/#715.