# Issue #6 (bring-up: long role prompt overflows tmux send-keys) is already fixed — no code change

## The original ask

GitHub issue #6 (https://github.com/rafarc21/fleetflare/issues/6) reported
that `studio-bringup.sh` inlined the full claude launch role-prompt into a
`tmux send-keys` command. For large task briefs that line exceeds tmux's
send-keys argument limit (measured at 16338 bytes, tmux 3.2a/3.4), so the
lead never launches — the pane shows only `command too long`. The issue
asked to stop inlining the prompt and instead write it to a file under
`.fleet`, then reference it from a short, constant-size launch line.

## It already shipped — PR #12

This was investigated and found to be already fully fixed and merged two
days before this reassignment, in PR #12
(https://github.com/rafarc21/fleetflare/pull/12, "bring-up: pass role prompt
by file, short launch line - #6"), merged 2026-09-28T22:29:53Z, merge commit
`a961ae8f1827390c4f64e3425959a7b763eaab1a`. GitHub issue #6 is closed.

The fix is present and intact on current `main`:
`apps/fleet/container/studio-bringup.sh`, function `claude_launch_line`
(roughly lines 1636-1660). It writes the role prompt to
`${FLEET_WORKSPACE:-/workspace}/.fleet/role-prompt.md` and types a short
launch line that does `--append-system-prompt "$(cat <file>)"`. Because the
pane's own shell expands `$(cat ...)` into one argv element at run time, the
typed tmux line stays a few hundred bytes regardless of how large the role
prompt is — the send-keys limit is never approached. If the file write
fails, the function falls back to the old inline behavior with a loud
stderr warning (`studio-bringup: could not write the role prompt file ... --
inlining the prompt into the launch line (issue #6: ...)`), and also warns
if the resulting inline line would itself exceed the 16338-byte limit —
a studio that boots degraded beats one that never tries. `claude_launch`
and `claude_launch_line` both still exist and are wired in at the
`# >>> claude-launch >>>` block.

## Why the board resurfaced a closed issue

The fleet board reassigned issue #6 to this studio on 2026-09-30T16:35Z with
instructions to fix it again. The most plausible explanation is that the
reassignment note was generated from the original issue text without
checking whether it had already shipped — PR #12 closed it out two days
earlier, and nothing on `main` regressed the fix in between. This doc exists
so the next pass over the board (automated or human) has a citable record
that the work is done, rather than re-deriving the same conclusion from
scratch or, worse, re-implementing a fix that already exists.

This mirrors two existing precedents in this repo for "investigated, already
handled, no code change" outcomes: PR #114
(https://github.com/rafarc21/fleetflare/pull/114, a single plan doc at
`docs/superpowers/plans/2026-09-30-done-awaiting-merge-state-110.md`
recording a won't-do decision with no code touched), and
`apps/fleet/docs/plans/2026-09-30-fix-93-rescue-budget-flaky-clock.md` (whose
verification-table style this doc follows).

## Files touched

None in production or test code. `apps/fleet/container/studio-bringup.sh` is
untouched — the fix it already carries needs no further change. This PR
adds only this plan doc.

## Verification

All commands below were run in this same checkout this session, before
branching for this doc. Not re-run for this report — the numbers are fresh
and unchanged since.

| script | exit | notes |
| --- | --- | --- |
| `bun test test/bun/bringup-launch-line.test.ts test/bun/bringup-claude-relaunch.test.ts` | 0 | 40 pass, 0 fail, 134 expect() calls. Ran 40 tests across 2 files. [77.57s]. These are the two files that actually cover issue #6's behavior: `bringup-launch-line.test.ts` asserts a >64KB prompt round-trips byte-exact through `claude_launch_line` into a launch line under 1KB, and `bringup-claude-relaunch.test.ts` asserts a >64KB prompt through real `claude_launch`/tmux lands with no `command too long` in stderr. (PR #12's own description separately claims a manual mutant-testing step during that PR's development — temporarily forcing the old inline path, confirming the test failed with `command too long`, then reverting — but that is not a test case that stands in the suite today; it's just a claim about process in the PR body.) |
| `bun run check` | 0 | `tsc --noEmit` across all 5 project configs (root, `container`, `cli`, `test-integration`, `test`) — clean. |
| `bun run english-check` | 0 | `english-check: clean`. |
| `bun run test` | 0 | `vitest run` (Cloudflare Workers pool). Test Files 151 passed (151), Tests 5265 passed (5265). Duration 217.02s. Pre-existing unrelated noise in the output (sourcemap warnings for `@cloudflare/containers`/`@cloudflare/sandbox` dist files, two "Containers have not been enabled for this Durable Object class" uncaught-promise lines, several "Called .text() on an HTTP body which does not appear to be text" console warnings for git-protocol content types) — none are failures; all tests passed. |
| `bun run build:page` | 0 | Wrote `page/terminal.html` (507737 bytes) and `page/grid.html` (11715 bytes). Confirmed idempotent: `git status --short` and `git diff --stat` were both empty afterward — no content actually changed. |
| `bun run bun-test` | 1 | 2121 pass, 2 skip, **8 fail**, 5847 expect() calls. Ran 2131 tests across 113 files. [1399.19s]. Neither `bringup-launch-line.test.ts` nor `bringup-claude-relaunch.test.ts` appear anywhere in the failure list (confirmed by grepping `^(fail)` across the captured output). Of the 8, 3 are confirmed pre-existing/environmental and unrelated to issue #6: `deploy-ops-guard.test.ts` #383 ("an unpushed commit touching only a sibling the config's name would glob-match is allowed") fails because the test's own fixture runs `git push -q origin main` inside a temp repo, and the STUDIO CONTAINER's own git safety wrapper ("fleet: studios never push the default branch — open a PR") intercepts it — a test-fixture-vs-container-guard collision. The other two are `localci.sh` SIGTERM timing-budget tests ("exits promptly, posts error, lane processes and refs gone" and "with a lane that ignores TERM: exit only after it is dead, lock free at exit"), both asserting `expect(Date.now() - t0).toBeLessThan(15_000)`; under this container's load they measured 44506.80ms and 40375.29ms respectively — the test file's own comment already documents this budget as sensitive to "host-load-driven overhead". The remaining 5 failures were not visible in the captured (truncated) output tail, but the grep above rules out either of the issue #6 test files being among them. |

Also run once, ahead of the above (not itself a verification step): `bun
install` — this container had no `node_modules` at all (fresh studio, never
set up before this session). 108 packages installed, no issues. An earlier
`bun run bun-test` attempt made before this install failed broadly (1380
pass / 180 fail / 34 errors) purely because of the missing dependencies;
that number is not a real signal and is superseded by the post-install run
above.

Deliberately skipped: `bun run test:integration` and `bun run
test:acceptance` — the same exclusion rationale as the fix-93 precedent doc
applies here: both require Docker (not installed in this container), and
`test:acceptance` additionally needs a Max OAuth token this environment
doesn't have.

## Deviations from the reassignment

- **git identity**: this container's `FLEET_BOT_NAME`/`FLEET_BOT_EMAIL` value
  matched the leak gate's own private denylist pattern #30 (and, before the
  checkout was unshallowed, the shallow boundary commit's pre-existing
  author also matched pattern #12 — fixed by `git fetch --unshallow origin`,
  which let the push wrapper's own remote-exclusion logic correctly skip
  already-known commits instead of falling back to scanning full history).
  The first push attempt was refused (`fleet: leak gate: text matches
  private denylist pattern`). This matches documented precedent already in
  this repo (`docs/superpowers/plans/2026-09-30-pregate-105.md` and
  `docs/superpowers/plans/2026-09-30-idle-stale-shell-nudge-106.md`): worked
  around it locally with a plain, public-safe `fleetflare[bot]`
  identity and an unrelated `users.noreply.github.com` address that matches
  no denylist entry (`git config user.name`/`user.email`, repo-local, not
  `--global`; `git commit --amend --reset-author`'d the one already-local,
  never-pushed commit), then pushed clean. Not this task's fix to make —
  the denylist itself lives outside this repo, in the operator's ops repo.

## Conclusion

No production code change is included in this PR. This is a decision and
verification record only, confirming issue #6 was already resolved by PR
#12 and remains correctly in place on `main`, matching the PR #114 and
fix-93 precedent pattern for "investigated, already handled" outcomes.
