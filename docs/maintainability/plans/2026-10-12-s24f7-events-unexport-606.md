# S24-F7 plan — un-export four events/ symbols past their consumers

Task: https://github.com/rafarc21/fleetflare/issues/606 (parent sweep #588, finding S24-F7, GLM-OK tier).
Doc: `docs/maintainability/2026-10-12-unused-exports-sweep-24.md` §S24-F7.

## Problem

Four symbols in `src/events/` carry the `export` keyword but have zero consumers outside their defining file. An export is an interface promise; each of these is a file-private helper wearing the keyword. A test or sibling module could start importing them, growing the public surface of the events modules.

## Change

Drop the `export` keyword on each line below. The symbol and its body stay; only the keyword goes. One word per line, four lines, three files.

| Symbol | Defining file:line | In-file use |
|---|---|---|
| `CTO_ID` | `src/events/rules.ts:3` | `:40` (CTO escalation check) |
| `Decision` | `src/events/rules.ts:5` | `:26` (routeDecision's return type) |
| `D1PortStatement` | `src/events/log.ts:39` | `:40`, `:47` (D1Port's method signature) |
| `NewEvent` | `src/events/schema.ts:24` | `:35` (makeEvent's parameter type) |

Keep exported: appendEvent, D1Port, makeEvent, routeDecision, dedupeKey, readSince, shortId — the actual consumed surface. Explicitly out of scope: everything else in the three files, and all Directus `Decision` types (different module).

## Pre-verified before this plan (2026-10-12)

Per symbol, word-boundary grep across all of apps/fleet (src, cli, container, test, test-integration, scripts, page) → the defining file only. No export-star (`export *`) anywhere. No named re-export list contains any of the four. No test imports any of them. Line refs verified at origin/main `ce878f1`.

## Steps

1. This plan doc (this commit).
2. Remove the `export` keyword on the four lines — one commit, mechanical.
3. Verify: `cd apps/fleet && bun run check` exit 0 (this is the mutation test: any hidden importer turns it RED); targeted vitest events tests still pass.
4. Fresh-context review, max 2 rounds.
5. PR, envelope on the issue.

## Verification

- `cd apps/fleet && bun run check` (tsc --noEmit across five tsconfig projects) exit 0. Heavy gate — run alone, nothing else heavy in parallel.
- Targeted: `cd apps/fleet && npx vitest run test/events.rules.test.ts test/events.log.test.ts test/events.schema.test.ts` exit 0.
- No behavioral change: symbols stay, bodies stay, call sites stay.
