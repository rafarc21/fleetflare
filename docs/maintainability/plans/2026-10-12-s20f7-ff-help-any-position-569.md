# Plan — S20-F7: `ff` recognizes `--help`/`-h` in every position, never files a flag as a task (refs #569)

Sweep 20 finding F7 (refs #541). One defect: parseFfArgs (src/studio/ff.ts:179) checks `--help`/`-h` only on the FIRST token, so `ff web-studio --help` parses to a new-task brief titled "--help" — files a board issue AND spawns a studio for it when the user asked for help. The `--new` flag (ff.ts:177-178) is already lifted out of argv before the positional grammar runs; help deserves the same treatment.

## Changes

1. ff.ts parseFfArgs: filter `--help` and `-h` tokens out of argv exactly the way NEW_INSTANCE_FLAG is filtered, BEFORE the positional grammar. Any occurrence anywhere → `{ cmd: "help" }`, decided before role/task parsing so it wins even alongside a role and a task. Because the filter removes them from the positional count, `ff pilot --new --help` is help, and `ff pilot "drop the --help flag"` (one quoted argv entry containing the word) stays a task — exact token match only, same containment rule `--new` already has.
2. A task that trims empty after the filter still hits the existing "the task is empty" usage error (ff.ts:190), so `ff --` alone stays a usage error, exit 1 — never a filed issue. This path needs no new code; it is pinned by a test.
3. FF_HELP text needs no change: `ff --help` is already documented; this fix makes the documented behavior true in every position.

## Verification

- vitest: test/studio.ff.test.ts — extend the existing `--help and -h ask for help` pin with later-position cases (`ff web-studio --help`, `ff --new --help`, `ff pilot --new --help`, mixed with a role) and a containment pin (`--help` inside a quoted task stays a task, flag-shaped token NEVER becomes task text). RED first: `ff web-studio --help` must fail against the current parser.
- `cd apps/fleet && bun run check` (one heavy gate, run alone)
