# S43-F12: CONTINUE_GUARD() bring-up pin -> helpers/adopt-fixtures.ts continueGuardLine() (refs #850, refs #888)

Census: sweep 43, finding F12 (dup-fixtures). Two bun-lane suites carry a
byte-identical 5-line `CONTINUE_GUARD()` that extracts the
`claude_has_conversation ... --continue` guard line from the BRINGUP source
and throws if not found:

- bun/bringup-fresh-session.test.ts:22
- bun/bringup-session-adopt.test.ts:27

## What

helpers/adopt-fixtures.ts (already owns the adopt-lane consts and
projects()/session()) gains `continueGuardLine()`: the same find over
`BRINGUP.split("\n")` for the line containing both
`if claude_has_conversation ` and `--continue`, throw if absent, return
trimmed. Both suites import it and drop their local copies.

## Steps (TDD)

1. Add continueGuardLine() to helpers/adopt-fixtures.ts with a WHY comment
   (pins bring-up's shipped --continue guard line so a pinned fragment cannot
   drift from container/studio-bringup.sh; home is the adopt-lane helper
   because the pin is test-side).
2. Migrate bringup-fresh-session.test.ts: import { continueGuardLine } from
   "./helpers/adopt-fixtures" (merge into its existing import if it had one;
   it currently has none, so new import), delete local CONTINUE_GUARD, rename
   its 2 call sites to continueGuardLine().
3. Migrate bringup-session-adopt.test.ts the same way — it already imports
   { CLI, WT_ID, WT_KEY } from the helper, extend that import, delete local
   CONTINUE_GUARD, rename its 2 call sites.
4. Verify: `cd apps/fleet && bun test test/bun/bringup-fresh-session.test.ts test/bun/bringup-session-adopt.test.ts` then `bun run english-check` then `bun run test-lies-check`. All exit 0.

## Verification (gate budget)

Light only: two bun test files + two check scripts. NO full bun-test lane, no
vitest, no tsc -p test, no build. Run one command at a time, nothing parallel.

## Boundaries

- Three files only: the two test suites + helpers/adopt-fixtures.ts. No src/,
  no container/, no exec-snippet.ts changes (BRINGUP stays where it is; the
  helper imports it from "./exec-snippet" — note adopt-fixtures.ts sits in
  helpers/, so its import path is "../exec-snippet").
- Helper must NOT import anything from the suites. Import direction:
  suites -> helper -> ../exec-snippet only.
- No behavior change: same find predicate, same error message, same .trim().

Estimated ~10 lines removed.
