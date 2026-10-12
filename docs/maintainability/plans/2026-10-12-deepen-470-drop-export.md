# deepen-470 plan — drop `export` on 11 self-file-only functions

Task: https://github.com/rafarc21/fleetflare/issues/470 (parent sweep #428, finding F5, GLM-OK entries only).
Doc: `docs/maintainability/2026-10-12-dead-code-sweep-9.md` §F5.

## Problem

Eleven functions carry the `export` keyword but have zero consumers outside their defining file. An export is an interface promise; these are file-private helpers wearing the keyword. A test or sibling module could start importing them, growing the public surface of files that should not have more of it.

## Change

Drop the `export` keyword on each line below. The symbol and its body stay; only the keyword goes. One word per line, eleven lines, nine files.

| Symbol | Defining file:line | In-file call site |
|---|---|---|
| `isEnvelopeComment` | `src/board/comment-wake.ts:88` | `:139` |
| `isBotComment` | `src/board/comment-wake.ts:108` | `:142` |
| `isUnfinished` | `src/studio/quiescence.ts:56` | `:80` |
| `formatSnapshotAge` | `src/studio/recycle-cost.ts:18` | `:45` |
| `runGetStatus` | `src/studio/provision.ts:3412` | `:4070` |
| `parseReapState` | `cli/fleet.ts:2385` | `:2482` |
| `parseSinceArg` | `cli/junior.ts:113` | `:229` |
| `orcaRunner` | `cli/orca-workspace.ts:1176` | `:1365` |
| `defaultSalvageDestination` | `cli/orca-workspace.ts:789` | `:805` |
| `studioGhWrapperScript` | `src/studio/gh-wrapper.ts:60` | `:186` |
| `readReposFailureComment` | `src/github/read-repos.ts:186` | `:271` |

Note: issue body cites `cli/fleet.ts:2346` and `read-repos.ts:191/:276`, but those line numbers predate #476/#466 merging; current lines are `:2385`, `:2482`, `:186`, `:271` (verified by grep on 2026-10-12). Line drift, same symbols, same change.

Explicitly OUT of scope (CLAUDE-ONLY, excluded per issue): the do.ts trio (`startRefusedResponse`, `switchedBlockIn`, `refuseUnlessJuniorEnabled`) and `src/studio/accounts.ts:838` `requireAccountMapOn`. The Claude lane handles those.

## Pre-verified before this plan (2026-10-12)

Per symbol, grep across all of apps/fleet (src, cli, test, test-integration, scripts, page, container) → the defining file only. No export-star (`export *`) anywhere in src/cli. No named re-export list contains any of the eleven. No test imports any of them.

## Steps

1. This plan doc (this commit).
2. Remove the `export` keyword on the eleven lines — one commit, mechanical.
3. Verify: `cd apps/fleet && bun run check` exit 0; targeted tests listed in the issue still pass.
4. Fresh-context review, one round max (operator tail).
5. PR, envelope on the issue.

## Verification

- `cd apps/fleet && bun run check` (tsc --noEmit on all five tsconfigs) exit 0. Heavy gate — run alone.
- Targeted tests: test/board.comment-wake.test.ts, test/studio.quiescence.test.ts, test/github.read-repos.test.ts, test/cli.read-repos-args.test.ts, test/studio.observation.test.ts, test/studio.provision.test.ts, test/bun/fleet-reap.test.ts, test/bun/fleet-reap-wiring.test.ts, test/cli.reap-terminal.test.ts, test/cli.junior-sweep.test.ts, test/bun/orca-workspace.test.ts, test/bun/gh-wrapper.test.ts.
- No behavioral change: symbols stay, bodies stay, call sites stay.
