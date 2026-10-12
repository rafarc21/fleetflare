# fix-567 plan — shared idArg(): no flag-shaped id, no trailing tokens

Task: https://github.com/rafarc21/fleetflare/issues/567 (sweep 20 finding
S20-F5, refs #541; sweep doc: docs/maintainability/2026-10-12-cli-args-sweep-20.md,
landed on main in 7bed49f).

## Problem

`check`/`paste`/`clear-session-guard`/`inspect` (cli-args.ts:913-918, paste
:827-828) take whatever single token followed the verb as the id — no flag
check, trailing tokens never examined. Today `fleet check --json` parses to
`{"cmd":"check","id":"--json"}` (a Worker request for a studio named
"--json"), and `fleet check x --json` parses with id "x" while the trailing
`--json` is silently dropped. `destroy` (cli-args.ts:928-935) already
documents and pins why a flag sliding into the id slot must be a usage error.

## Change

Two files.

- apps/fleet/src/studio/cli-args.ts: one shared `idArg(argv, verb)` helper —
  the id must exist, must not start with `--`, and no token may follow it —
  returning `usage(...)` with exit 1 (e.g. `fleet check needs a studio id
  (got "--json")`). Wire into check/paste/clear-session-guard/inspect.
  attach already mostly conforms; destroy stays bespoke.
- apps/fleet/test/studio.cli-args.test.ts: extend the four existing
  "requires an id" tests with flag-shaped-id and trailing-token pins; add
  the not-starting-with-`--` happy-path boundary where absent.

## Steps

1. This plan doc (this commit).
2. RED: extend the four id tests in test/studio.cli-args.test.ts; run
   `bunx vitest run test/studio.cli-args.test.ts` from apps/fleet — new
   assertions fail against current src. Commit + push.
3. GREEN: the idArg() helper + 4 verb wirings; same run green. Commit + push.
4. Verify: vitest (touched file only), bun run test-lies-check,
   tsc --noEmit -p cli — heavy gate, ALONE, nothing parallel.
5. Fresh-context review, QA behavioral run, done record, PR, envelope.
