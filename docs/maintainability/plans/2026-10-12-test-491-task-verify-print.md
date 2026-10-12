# test-491 plan — behavioral test for `cmdTaskVerify`'s print loop

Task: https://github.com/rafarc21/fleetflare/issues/491 (sweep 11 finding S11-F3, refs #467).
Doc: `apps/fleet/docs/maintainability/2026-10-12-cli-coverage-sweep-11.md` §S11-F3.

## Problem

`cmdTaskVerify` (cli/fleet.ts:1797, dispatch :3029) prints what the Worker's
verify route found, and none of it is tested: the per-result icon lines
(✅ attempted-ok / ❌ attempted-failed / ➖ other, `icon` helper :1806-1807),
the envelope header naming `envelopeMsgId` (:1808), the trailing
`comment: <url>` line (:1810), and `boardRequest`'s exit-1-on-500 posture
(:1596-1605). The Worker's own verify logic IS tested (test/board.verify.test.ts);
this CLI half is the hole.

## Change

One new test file, no src changes: `apps/fleet/test/bun/cli.task-verify.test.ts`.
Bun lane, sweep-11 pattern (a) — real `Bun.spawn` of `cli/fleet.ts` against a
local `Bun.serve` Worker stand-in, temp HOME whose `~/.fleet/credentials`
names the stand-in (prior art: `test/bun/accounts-cli.test.ts`).

## Test design

Stand-in answers POST `/studio/board/tasks/77/verify` with a two-result body:
one `attempted-ok`, one `attempted-failed`, plus `comment.url` and
`envelopeMsgId`. Assert on the spawned process's stdout:
- `fleet task verify #77 — checking result envelope <id>:` header
- `  ✅ attempted-ok — <label>: <detail>` line
- `  ❌ attempted-failed — <label>: <detail>` line
- `comment: <url>` trailing line
- exit 0, and the request carried POST + the `repo` body from git remote detection.

Second run: stand-in answers 500 with a text body; assert exit 1 and stderr
`fleet task verify: 500 ` prefix.

Run under `cwd` = the repo root or a fixture dir with a git remote named
`origin`? detectRepo runs `git remote get-url origin` from the spawn cwd —
spawn with `cwd` set to the repo checkout itself is simplest and matches
real usage; the `repo` body assertion then pins `rafarc21/fleetflare`… BUT the
public-repo rule forbids nothing here (repo slug is public). Simpler and
hermetic: set cwd to a temp dir with NO git repo — detectRepo then returns
`{slug: null}`, reportRepo prints the fallback line, and the POST body is
`{}`. Assert the body is `{}` (empty repo field) and the fallback stderr line
`fleet task verify: could not read` — actually the exact reason line for a
non-git cwd. Assert request body `{}` and exit 0. That keeps the test hermetic
(no dependence on the checkout's remote URL) while still covering the request
half. Do it hermetic: temp cwd, no git.

## Steps

1. This plan doc (this commit).
2. RED: write `test/bun/cli.task-verify.test.ts` per the design above; run
   `cd apps/fleet && bun test test/bun/cli.task-verify.test.ts` — it must
   pass against current src (this is coverage-adding, not bug-fixing; there
   is no code to mutate for a RED phase since the src is not changing — the
   sweep's test-lies-check stance: behavioral test, pinning real output).
   For the mutation check instead: temporarily change one icon in fleet.ts,
   watch the test fail, revert — that proves the test can lie-detect.
3. GREEN: revert the mutation, `bun test test/bun/cli.task-verify.test.ts` green.
4. `cd apps/fleet && bun run check` — heavy gate, run ALONE, nothing else in parallel.
5. Fresh-context review (lead dispatches), QA not needed (no UI), PR, envelope.
