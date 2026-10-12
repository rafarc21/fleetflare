# Behavioral tests for `fleet check` / `fleet clear-session-guard` — plan (board issue #495)

Ref #495 (sweep 11 finding S11-F7, refs #467). TESTS ONLY — no src/ or
cli/ change. New file `apps/fleet/test/bun/cli-check-clear-guard.test.ts`,
bun lane, same harness family test/bun/cli-destroy-unmerged.test.ts
documents: Bun.spawn of the real cli/fleet.ts against a Bun.serve Worker
stand-in, temp HOME with synthetic ~/.fleet/credentials. Neither cmd is
exported (cli/fleet.ts runs its CLI on import), so the subprocess lane is
the only lane that can observe the wiring.

## Steps

1. Harness in-file, same shapes as cli-destroy-unmerged.test.ts:
   tmpHomeWithCredentials, a stand-in serving POST /studio/<id>/check
   and POST /studio/<id>/clear-session-guard from per-test scripts, with
   request recording.
2. `fleet check <id>`: happy path 200 row → exit 0, stdout = one-row
   table + optional full-ERROR line + READY_CAVEAT; long-error row also
   prints `ERROR (full): <text>` (error flat-whitespace over 160 chars);
   short-error row prints none; 500 plain body → exit 1, stderr exactly
   `fleet check: 500 <body>`; 500 JSON `{error}` body → reason printed,
   not raw JSON; 200 non-row body → exit 1, exact
   `answered 200 but the body was not a studio row` refusal.
3. `fleet clear-session-guard <id>`: happy path → exit 0, table, stderr
   one-shot/superseded warning naming the id; 500 → exit 1, stderr
   `fleet clear-session-guard: 500 <body>`; 200 non-row → exit 1, exact
   refusal wording.
4. READY_CAVEAT is not exported — assert distinctive substrings from
   captured stdout ("ALIVE, not WORKING", "ACTIVITY (issue #221)")
   instead of an exact-string import pin; test-lies-check stays clean.
5. RED first (one deliberately wrong assertion, run, see it fail),
   then green. Commit, push branch.

## Verification

- `cd apps/fleet && bun test test/bun/cli-check-clear-guard.test.ts` — pass.
- RED run (same command, mutated assertion) exits non-zero — serial, never parallel.
- `cd apps/fleet && bun run scripts/test-lies-check.ts` — 0 findings.
- `git diff origin/main --stat` — exactly 2 files: test + this plan.

## Boundaries

Tests only. No src/, cli/, container/ change. bun-test runs 2x (RED+GREEN)
plus one test-lies-check — serial only.
