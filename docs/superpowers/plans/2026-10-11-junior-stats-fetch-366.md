# Plan — #366 S4-F6: tagged-result fetch for fleet junior stats

Sweep 4 F6 (GLM-OK, behavior-preserving). cmdJuniorStats hand-rolls fetch + access headers + !res.ok throw + res.json() cast inside a soft-fail try/catch (cli/junior.ts:181-191). The task-state fetchers in cli/fleet.ts:1492-1529 already established the tagged-result shape; boardRequest is process-exit and cannot be reused from the root bun test pool. Full FleetClient unification stays with sweep-2 F1.

## Steps

1. RED: test/bun/junior-stats-unit.test.ts — injectable-fetch tests for cmdJuniorStats + direct fetchJuniorUsage tests: worker ok maps rows; non-ok maps {ok:false,status,message}; thrown fetch maps {ok:false,status:0,message}; cmdJuniorStats soft-fails (stdout table, stderr warning, exit 0); hard usage error still exits 1.
2. GREEN: cli/junior.ts — export JuniorUsageFetch + fetchJuniorUsage(creds, sinceMs, doFetch = fetch); cmdJuniorStats(creds, since, deps) consumes it; default deps keep CLI behavior byte-identical.

## Behavior preserved

Same URL, same headers, same stderr warning text, same merged table, exit 0 on worker failure, exit 1 on bad --since. Two-way door (code-only, revertable).

## Boundaries

Heavy verification: bun test on the two touched test files only (runs ~2s, no bundler, no full suite). tsc -p cli is the only typecheck gate; run once at the end.
