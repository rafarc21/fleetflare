# Pin `date +%s` in the rescue budget single-push threshold test (board issue #93)

## The flake, as measured

`test/bun/rescue-push.test.ts`, describe block "#371 review Finding 1 — the
budget guard doubles its threshold at rescue_push()'s own retry-capable call
sites", second test ("remaining budget covers only a SINGLE push (between the
single and doubled thresholds) — the checkpoint is skipped as RESCUE_FAILED
checkout budget <n> not attempted, never allowed to attempt the retry"), fails
intermittently in the CI `bun-test` lane. Seen on PR #44 (2026-09-29,
`ee30915`) and PR #90 (2026-09-30) — neither PR touches `rescue.ts` or this
test file at all; a rerun of the exact same commit passes.

The assertion that fails is an exact-literal regex match:

```ts
expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout budget ${serverDeadlineSeconds} not attempted$`, "m"));
```

with `serverDeadlineSeconds = Math.floor((singleThreshold + doubledThreshold) / 2) = 10`
(`pushTimeoutSeconds=2`, `KILL_GRACE_SECONDS=5` ⇒ `singleThreshold=7`,
`doubledThreshold=14`).

The generated bash script's budget guard (`src/studio/rescue.ts`):

```sh
__rescue_start=$(date +%s)
...
rescue_budget_ok() {
  local id="$1" mult="${2:-1}" now remaining
  now=$(date +%s)
  remaining=$(( ${serverDeadlineSeconds} - (now - __rescue_start) ))
  if [ "$remaining" -lt $(( mult * (${pushTimeoutSeconds} + ${KILL_GRACE_SECONDS}) + ${budgetMarginSeconds} )) ]; then
    echo "RESCUE_FAILED $id budget $remaining not attempted"
    ...
```

`date +%s` truncates to whole seconds. In `rescue_one`, for the "checkout" id,
`rescue_target` + `git add` + `git commit --no-verify` all run for real
BEFORE `rescue_budget_ok "$id" 2` is checked. On a loaded/slow CI runner,
those real git subprocess calls can occasionally cross a whole-second
boundary between the `__rescue_start` capture and this checkpoint's own `now`
— `now - __rescue_start` reads `1` instead of `0`, `remaining` becomes `9`
instead of `10`, and the exact-literal assertion above fails to match — even
though the guard behaved perfectly correctly (it still correctly refused to
attempt the push, `remaining=9` still well clear of `singleThreshold=7`).
Only this TEST's own hardcoded expectation of the literal number `10`
breaks. This is a test-determinism bug, not a `rescue.ts` bug — confirmed by
both PRs that hit it touching neither file.

The sibling test immediately above it ("remaining budget covers the DOUBLED
(retry-pair) threshold") is not affected: PR #376 review already gave it
~3s of explicit slack (`marginSeconds = 3`) after an earlier real 4/5-Mac
failure rate at zero margin. The failing test has no such margin — it sits
exactly on `rescue_budget_ok`'s own arithmetic by design (proving the
single-vs-doubled midpoint), which is exactly why a 1-second `date`
truncation race can flip its result.

## The fix

This file already has precedent for pinning `date` deterministically via a
PATH shim: the "#263 C4" describe block (`agent-dup under .claude/worktrees`
test) shims `date -u +%Y%m%d%H%M%S` to a fixed value so two worktrees
generate the identical timestamp, forcing a ref-naming collision
deterministically. Same mechanism, scoped to only the one flaky test (not the
sibling "DOUBLED threshold" test, which already has its own margin and isn't
reported flaky):

```sh
#!/bin/sh
if [ "$1" = "+%s" ]; then echo 1700000000; else exec /usr/bin/date "$@"; fi
```

This intercepts specifically `date +%s` — the only invocation shape
`rescue_budget_ok`'s wall-clock math uses — and returns a fixed constant
epoch every call, falling through to the real `/usr/bin/date "$@"` for every
other shape (so `rescue_target`'s own `date -u +%Y%m%d%H%M%S` timestamp
generation still works for real, even though in this specific test it's never
reached in the output — the budget check fails before any push is
attempted).

The shim dir is prepended onto `BASE_PATH` (same as the C4 test) when
invoking `sh(rescuePushCmd(...), dir, { PATH: shimDir + ":" + BASE_PATH })`
for this one test only. With every `date +%s` call pinned to the identical
value, `now - __rescue_start` is always exactly `0`, so `remaining` is always
exactly `serverDeadlineSeconds` (10) — deterministic, zero real-wall-clock
dependency, matching the issue's own suggested fix ("inject clock/budget, no
real time").

The existing `elapsedMs < 1000` assertion is left in place: it measures the
TEST's own wall time (proving the guard didn't wait around), which is
unrelated to the internal `date +%s` race the shim fixes.

## Files touched

- `test/bun/rescue-push.test.ts` — the one test named above gets a
  `mkdtempSync`/`writeFileSync`/`chmodSync` PATH shim for `date +%s`, plus a
  comment citing issue #93 and the root cause, so a future reader doesn't rip
  it out as dead code. No production code (`src/studio/rescue.ts`) is
  touched — the guard's behavior was already correct; only the test's own
  clock dependency needed pinning.

## Verification

Targeted loop (not a full gate — a single-test bun invocation run
repeatedly), confirming the race is gone:

```
$ cd apps/fleet && for i in $(seq 1 15); do bun test test/bun/rescue-push.test.ts \
    -t "remaining budget covers only a SINGLE push" || echo "FAIL run $i"; done
```

15/15 passed, zero failures, zero variance in the exact-literal `budget 10`
match.

Package.json scripts run, one at a time, under `flock /tmp/fleet-gate.lock`:

| script | exit | notes |
| --- | --- | --- |
| `bun run bun-test` | 1 | 2052 pass, 2 skip, **6 fail** — all 6 in `test/bun/deploy-ops-guard.test.ts` ("studios never push the default branch" guard tests), a file this change never touches. Reproduced identically (same 6 failures) running that file alone, and reproduced identically against a clean `main` checkout in an isolated `git worktree` with no changes applied at all — pre-existing on `main`, unrelated to issue #93. The specific rescue-push.test.ts tests this task targets are all green in the same run. |
| `bun run check` | 0 | `tsc --noEmit` across all 5 project configs (root, `container`, `cli`, `test-integration`, `test`) — clean. |
| `bun run test` | 0 | `vitest run` (Cloudflare Workers pool) — clean. |
| `bun run english-check` | 0 | clean. |

Deliberately skipped: `bun run test:integration` and `bun run test:acceptance`
— both require Docker (`which docker` returns nothing in this container),
and both source files (`test-integration/attach.e2e.ts`,
`test-integration/cli.acceptance.ts`) document that exclusion from normal CI
in their own file headers.
