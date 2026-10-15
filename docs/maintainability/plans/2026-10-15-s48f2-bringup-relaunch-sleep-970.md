# S48-F2 bringup-claude-relaunch — 3000ms sleep → 1000ms; per-test FakeStudio stays (refs #970, refs #945, refs #715)

`apps/fleet/test/bun/bringup-claude-relaunch.test.ts`, measured 76.7s (sweep 48, F2).

(a) `:819` `Bun.sleepSync(3000)` in "the fake lead STAYS UP" — a fixed wait proving
the lead is not relaunched. The relaunch bug fired within ~300ms when present;
1000ms carries the same claim. Cut to 1000ms.

(b) 32 tests each `fresh()` a FakeStudio. Investigated sharing one session per
describe — rejected:

- Sharing needs a live-pane reset between tests (C-c, kill lead, wait for bash,
  restore `bin/tmux` after `interpose`, reset the window name — several tests
  use `start("shell")` / `start("claude", "sleep 120")`).
- This suite is a SAFETY harness: isolation is one mechanism, not two (line 49).
  Test N+1 depending on test N leaving a clean pane is the cross-test pollution
  it exists to prevent; it killed a studio's tmux twice on 2026-09-24.
- Per-test session setup is a real cost (sweep-48 estimates ~2s each), but the
  safety argument above is the decisive reason: sharing would trade isolation
  for a speed-up this harness's own header warns against.

Decision: keep per-test `fresh()`. No code change for (b).

## Change
- `apps/fleet/test/bun/bringup-claude-relaunch.test.ts:819`: `3000` → `1000`,
  with a one-line comment naming the ~300ms relaunch-bug fact.

## Steps
1. Plan doc commit + push.
2. Edit the sleep to 1000ms; run the suite. TDD note: the constant is a fixed
   wait, not a branch — there is no writable RED test for it; the existing suite
   (32 tests, real tmux, real /proc counts) is the regression guard. Confirm
   STAYS-UP still green and the file runs well under 76.7s.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/bringup-claude-relaunch.test.ts` — all pass.
- `cd apps/fleet && npx tsc --noEmit -p test` — exit 0.
- `cd apps/fleet && bun run english-check` — clean.

## Boundaries
- One file, one line. No container/, src/, cli/. No closing keywords for #945/#715.
- Heavy-gate budget: `bun test` on this one file only; `tsc -p test` only.