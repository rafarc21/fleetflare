# Plan — #497 S11-F9: direct tests for attachTitleState / titleSequence / hhmmssZ

Refs #497, #467. Sweep-11 finding S11-F9: three exports in
`cli/attach-liveness.ts` have zero direct tests. `attachTitle` itself is
tested (test/bun/attach-liveness.test.ts:186); the other three are not.

## Why they matter

- `attachTitleState` (:39) is load-bearing: cli/orca-workspace.ts:311,373,974
  decide from it whether an Orca terminal is an attach terminal and whether
  it is stale. A reworded title must fail closed (null, :44-46) and the
  waiting/live/stale round-trip must hold.
- `titleSequence` (:50) emits the OSC-0 + BEL title bytes.
- `hhmmssZ` (:19) renders the STALE title's "since HH:MM:SSZ" clock.

The module imports nothing, so vitest imports it directly — same lane as
test/cli.input.test.ts. No bun lane needed.

## Steps

1. New `test/cli.attach-liveness.test.ts` (vitest, describe/it style like
   test/cli.input.test.ts):
   - round-trip waiting and live: attachTitleState(id, attachTitle(id, state))
   - stale: real since/now round-trips to "stale"
   - fail closed: reworded prefix (capitalized "Fleet "), another studio's
     id, undefined title — all null
   - titleSequence(t) is exactly `\x1b]0;{t}\x07`
   - hhmmssZ(0) === "00:00:00Z"; known epoch slices to the UTC clock
2. Targeted run: `bunx vitest run test/cli.attach-liveness.test.ts` — green.
3. Gates, one at a time: `bun run check`, then `bun run english-check`.
4. Fresh-context Code Reviewer, fix findings, PR refs #497 (no closing
   keyword).

## Verification

- Targeted vitest run green.
- `bun run check` exit 0; `bun run english-check` exit 0.
- Full suite NOT run in-studio — belongs to local-ci / the merge gate.
