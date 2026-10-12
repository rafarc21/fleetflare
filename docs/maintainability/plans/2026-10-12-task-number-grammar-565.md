# fix-565 plan — shared task-number grammar: `^[1-9][0-9]*$` + safe integer

Task: https://github.com/rafarc21/fleetflare/issues/565 (sweep 20
finding S20-F3, refs #541).

## Problem

`fleet task show|verify|assign|state` gate the issue number only with
`/^\d+$/` (cli-args.ts:568-574,619), then call `Number(raw)`. So
`task show 0` parses to number 0 (GitHub's "no issue"; the CLI's own
`--continues` grammar at :741 already refuses 0), and
`task show 99999999999999999999` rounds past 2^53 to a number that
cannot be any real issue — a wasted Worker round trip where a usage
error belongs. No test pin covers `0` or >2^53 today
(test/studio.cli-args.test.ts pins non-numeric input only, :483,491,680,710).

## Change

One file plus tests.

- apps/fleet/src/studio/cli-args.ts: new helper

  `function parseIssueNumber(raw: string): number | null`
  `/^[1-9][0-9]*$/` and `Number.isSafeInteger(Number(raw))`, else null.

  Applied at the four call sites; each refusal keeps its existing
  first line and appends the got value, e.g.
  `fleet task show needs an issue number (got "0")`. Leading zeros
  ("042") are refused by the grammar too — same rule as `--continues`.
- apps/fleet/test/studio.cli-args.test.ts: RED pins first — for each
  of show/verify/assign/state, one test asserting `0` and one
  >2^53 string parse to `usage`; existing happy paths must stay green.

rescue-gc `--older-than` (:971) has the same hole but is rescue-lane
(CLAUDE-ONLY per the tier rule); the shared helper fixes it for free
once a rescue-lane task lands — NOT in this PR.

## Steps

1. This plan doc (this commit).
2. RED: the four pin tests; `bun test test/studio.cli-args.test.ts`
   from apps/fleet fails on the new pins. Commit + push.
3. GREEN: helper + four call sites; same test run green. Commit + push.
4. Verify: bun test test/studio.cli-args.test.ts, then
   `bun run test-lies-check`, then `bun run check` — heavy gate,
   ALONE, nothing parallel. english-check on the diff.
5. Fresh-context review (cap 2 rounds), done record, PR, envelope.
