# Sweep 18 F4: fold isolatedTmuxEnv → test/bun/helpers/tmux-env — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the 5 byte-identical `isolatedTmuxEnv(dir)` copies out of bun-lane real-tmux tests into a new `test/bun/helpers/tmux-env.ts`, with zero test-behavior edits.

**Architecture:** `test/bun/helpers/` is the bun-lane shared-helper home (`shell.ts`, `credentials.ts` exist; #618/#593 set the fold-only precedent — no new unit-test file for the helper; consumer suites are the verification). The 5 consumer files delete their local copy (comment paragraph + 3-line function) and import `isolatedTmuxEnv` from `./helpers/tmux-env`. The 6th copy (`pane-probe-lead.test.ts:146`) DIVERGES — prepends `<dir>/bin` to PATH and runs `assertIsolatedEnv` — so it stays local per the census's divergent-stays-local rule; only its comment pointers (which cite pane-probe.test.ts / wake-cmd.test.ts as the copy source) are updated to cite the shared helper. Cousins `bringup-active-window.test.ts` harness() and `bringup-tmux-render.test.ts` isolated() stay local (different env shapes — folding changes behavior).

**Spec:** board issue https://github.com/rafarc21/fleetflare/issues/594 and census finding F4 in `docs/maintainability/2026-10-12-test-helpers-sweep-18.md` (section "F4").

## Global Constraints

- Zero test-behavior edits: same env values, same assertions, same test bodies. Only the helper's source moves.
- THE SAFETY COMMENT MOVES WITH THE HELPER, VERBATIM (from wake-cmd.test.ts:16-28): TMUX/TMUX_PANE stripping is required because TMUX_TMPDIR alone is NOT isolation when running inside a live studio — tmux with `$TMUX` set targets the CURRENT server and ignores TMUX_TMPDIR; three studio leads died probing (and kill-server-ing) the live lead's own tmux before this was found. Losing that comment invites a fourth death. Do not paraphrase, do not shorten.
- `isolatedTmuxEnv` body must be byte-identical to the current copies: destructure `TMUX`/`TMUX_PANE` out of `process.env`, return `{ ...rest, TMUX_TMPDIR: dir }`.
- No new test file for the helper (fold-only, #618 precedent); verification = the 6 touched suites keep their exact baseline counts.
- Tests not in the touched set are not touched.
- All repository content English. Conventional Commits style, `refs #594` trailer.
- One heavy gate at a time: `bun run check` runs under `flock /tmp/fleet-gate.lock`, never alongside another gate or test run.
- Baseline (measured 2026-10-12, per-file): wake-cmd 6 pass, pane-probe 4 pass, inspect-cmd 10 pass, wake-submit-check 10 pass, incarnation-newline 3 pass, pane-probe-lead 11 pass — combined 44 pass, 0 fail, 114 expect() calls. These must be reproduced exactly.

---

### Task 1: this plan doc
- [ ] Commit this file alone: `docs(fleet): S18-F4 plan — isolatedTmuxEnv fold to bun/helpers/tmux-env (refs #594)`.

### Task 2: helper + 5 folds + lead pointer fix

**Files:**
- Create: `test/bun/helpers/tmux-env.ts`
- Modify: `test/bun/wake-cmd.test.ts`, `test/bun/pane-probe.test.ts`, `test/bun/inspect-cmd.test.ts`, `test/bun/wake-submit-check.test.ts`, `test/bun/incarnation-newline.test.ts` (delete local copy, add import), `test/bun/pane-probe-lead.test.ts` (comment pointers only)

- [ ] **Step 1: create the helper** `test/bun/helpers/tmux-env.ts` with EXACTLY this content (comment is the verbatim canonical block from wake-cmd.test.ts):

```typescript
/**
 * An env whose tmux can ONLY reach the throwaway server under `dir`.
 *
 * `TMUX_TMPDIR` alone is not isolation. When `TMUX` is set -- i.e. this test
 * runs INSIDE a tmux session, which is exactly where a studio lead runs it --
 * tmux targets the CURRENT server named in `$TMUX` and ignores TMUX_TMPDIR.
 * The session/window names here are the real ones (`studio:claude`), so this
 * suite then typed its fixtures into the live claude window and its
 * `kill-server` killed the studio outright. MEASURED 2026-09-18: a sentinel
 * server with those names died when this file ran inside it; three studio
 * leads died this way over two days. Stripping TMUX/TMUX_PANE makes tmux fall
 * back to TMUX_TMPDIR, i.e. the throwaway server, wherever the test runs.
 */
export function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}
```

- [ ] **Step 2: fold the 5 consumers.** In each file delete the local comment paragraph about TMUX/TMUX_PANE isolation AND the local 3-line `function isolatedTmuxEnv` block, then add `import { isolatedTmuxEnv } from "./helpers/tmux-env";`. Placement: with the other `./` imports if the file has any, else directly after the `../../src/...` import line — match the grouping style existing `./helpers/*` importers use (see accounts-cli.test.ts:17, junior-stats-cli.test.ts:11). Details per file:
  - `wake-cmd.test.ts`: comment block lines 16-28 + fn lines 29-32 (the fn's own doc comment IS the safety comment — delete the whole block including its opening `/**`). The file-header comment at lines 7-15 (about sendIntoRealTmux/quoting) STAYS.
  - `pane-probe.test.ts`: isolation paragraph lines 15-19 INSIDE the suite-header comment (lines 15-19 end with "Three leads died that way before it was found.") + fn lines 21-24. The rest of the suite header (lines 7-14, 20) stays intact; keep the comment well-formed (the header continues at line 26 with a new `/**` for probeAgainst).
  - `inspect-cmd.test.ts`: comment lines 19-23 + fn lines 24-27.
  - `wake-submit-check.test.ts`: paragraph lines 21-24 (last paragraph of the suite-header comment ending at line 25 `*/`) + fn lines 26-29. Header text lines 7-20 stays.
  - `incarnation-newline.test.ts`: comment lines 24-30 + fn lines 31-34.
  - Line numbers are from origin/main — re-read each file first and match by content, not blind line numbers.
- [ ] **Step 3: pane-probe-lead.test.ts pointer fix (NO behavior change, no import).** Its local fn at ~line 146 stays exactly as is. Update ONLY the two stale citations in its comment block (~lines 132-145): "Copied from test/bun/pane-probe.test.ts verbatim, for the reason that file's own comment gives" → "Same isolation as the shared test/bun/helpers/tmux-env.ts helper, for the reason that helper's own comment gives", and "the ONLY addition beyond the original wake-cmd.test.ts/pane-probe.test.ts copy this comment refers to" → "the ONLY addition beyond the shared helpers/tmux-env.ts copy this comment refers to". Keep the surrounding sentences (PATH/bin, installFakeClaude, assertIsolatedEnv guard, -S socket) untouched.
- [ ] **Step 4: GREEN run.** `cd /workspace/fleetflare/apps/fleet && bun test test/bun/wake-cmd.test.ts test/bun/pane-probe.test.ts test/bun/inspect-cmd.test.ts test/bun/wake-submit-check.test.ts test/bun/incarnation-newline.test.ts test/bun/pane-probe-lead.test.ts` — expect EXACTLY 44 pass, 0 fail, 114 expect() calls. If any count differs from baseline (6/4/10/10/3/11 per file), STOP and report — that is a behavior edit, forbidden.
- [ ] **Step 5: commit + push.** `git add -A apps/fleet/test/bun` (from repo root) then `git commit -m "refactor(fleet): isolatedTmuxEnv ×5 → test/bun/helpers/tmux-env (refs #594)"` then `LEFTHOOK=0 git push origin test-594-fold-tmux-env`.

### Task 3: gates + completion record
- [ ] **Step 1: typecheck gate, ALONE** (nothing else running): `flock /tmp/fleet-gate.lock bun run check` from apps/fleet. Expect exit 0.
- [ ] **Step 2: english-check.** `bun run scripts/english-check.ts`. Expect `english-check: clean`, exit 0.
- [ ] **Step 3: test-lies-check.** `bun run scripts/test-lies-check.ts`. Expect 0 tautological, 0 source-reading, 0 own-module-mock.
- [ ] **Step 4: completion record.** Write `/workspace/.fleet/done/594.json` (OUTSIDE the repo — must NEVER be committed or pushed) with the REAL output tails from the commands above:
  `{"plan": "docs/superpowers/plans/2026-10-12-sweep18-f4-fold-tmux-env-594.md", "verification": [{"cmd": "<the exact bun test command>", "exit": 0, "output": "<real tail: pass/fail/expect lines>"}, {"cmd": "flock /tmp/fleet-gate.lock bun run check", "exit": 0, "output": "<real tail>"}, {"cmd": "bun run scripts/english-check.ts", "exit": 0, "output": "english-check: clean"}, {"cmd": "bun run scripts/test-lies-check.ts", "exit": 0, "output": "<real tail>"}], "issue": "https://github.com/rafarc21/fleetflare/issues/594"}`
- [ ] **Step 5: final push check.** `git log origin/main..origin/test-594-fold-tmux-env` shows 2 commits, nothing unpushed. Plan doc must be committed on this branch.
