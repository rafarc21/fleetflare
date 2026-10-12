# CLI test-coverage sweep 11 — apps/fleet/cli (2026-10-12)

Ref #467. Read-only analysis of `apps/fleet/cli/*.ts` against
`apps/fleet/test/**` at `origin/main` b1d204b. No code changed. Sweep 11
of test-coverage gaps in apps/fleet/cli. Maestro files issues from
GLM-OK findings.

## Method

Brief: exported functions or command branches in `cli/*.ts` with no test
exercising them — grep census of `test/` for every export plus every
`case`/flag in the dispatch table, prioritizing operator-facing output
and exit codes. Excluded per the brief (CLAUDE-ONLY, nothing filed):
auth, secrets, credentials, rescue, failover, accounts routing, deploy.
Rescue-GC's print loop (S11-F6) prints a tested pure core's route
answers — not rescue behavior; `fleet rescue-all`/`rescue-push` itself
stays excluded.

Vitest cannot import `cli/fleet.ts` (bun-only globals). Two behavioral
patterns cover the unexported cmd halves, both in `test/bun/`:
(a) real `Bun.spawn` of `cli/fleet.ts` against a local `Bun.serve`
Worker stand-in, temp HOME whose `~/.fleet/credentials` names the
stand-in (`test/bun/accounts-cli.test.ts`,
`test/bun/cli-destroy-unmerged.test.ts`); (b) bun:test importing
`cli/fleet` directly (`test/bun/fleet-reap-wiring.test.ts`). Each
finding cites its pattern.

## Findings

### S11-F1. `cmdAccountsHold`/`cmdAccountsClear` — zero test references — GLM-OK

`cli/accounts.ts:459,471`, dispatched `cli/fleet.ts:3061-3064`. Worker
routes tested (`test/studio.routes.test.ts:3130-3184`), arg parser
tested (`test/studio.cli-args.test.ts:1123-1148`); no test imports
either cmd. Untested: body `{name, until?, reason?}` :463 / `{name}`
:473; success lines "held until X"/"held until cleared" :464 and
"cleared (was Y)" vs "had no row (already free)" :474; exit-1 through
`errText` (:466-467, :476-477). NOT accounts routing: manual hold/clear
verbs over tested routes (#336); sync/routing excluded. Proposed — bun
lane, pattern (a): spawn against a stand-in answering POST
`/studio/accounts/hold|clear`; assert the three success lines and exit
1 with the stand-in's text on a 4xx.

### S11-F2. `cmdMemoryLs`/`cmdMemoryCompact` — no behavioral test exists — GLM-OK

`cli/fleet.ts:2568,2606`, dispatched :3045-3048. Grep: zero refs to
`cmdMemoryLs`/`cmdMemoryCompact`/`memoryUrl` in `test/` (helpers
tested `test/cli.memory-format.test.ts`, routes
`test/memory.routes.test.ts` — the cmd halves are the hole). Untested:
ls's header :2582, the truncated WARNING (issue #187, :2589-2590), exit
1 on !res.ok (:2574-2577); compact's invalid-stdin-JSON refusal
:2615-2618, PR/branch/summary lines :2635-2640, same WARNING
:2644-2646. Proposed — bun lane, pattern (a): spawn against a stand-in
answering GET `/studio/memory` and POST `/studio/memory/compact`;
assert exact header/summary lines, WARNING presence/absence, exit codes
0 and 1; pipe invalid JSON — expect exit 1, the exact stderr line, zero
POSTs received.

### S11-F3. `cmdTaskVerify` print loop — untested — GLM-OK

`cli/fleet.ts:1797`, dispatched :3029. Untested: per-result icon lines
(✅ attempted-ok / ❌ attempted-failed / ➖ other, `icon` helper
:1806-1807), the envelope header naming `envelopeMsgId` :1808, the
trailing `comment: <url>` line :1810. The Worker's verify logic has its
own tests (`test/board.verify.test.ts`); this print loop does not.
Proposed — bun lane, pattern (a): spawn against a stand-in answering
POST `/studio/board/tasks/<n>/verify` with a two-result body (one
attempted-ok, one attempted-failed) plus comment url; assert both icon
lines with verdict/label/detail, the header, the comment line, exit 0;
a 500 run asserts `boardRequest`'s exit-1 posture (`fleet task verify:
500 ...`, :1596-1605).

### S11-F4. `taskStateFetchCurrent`/`taskStateFetchTransition` — real fetch halves — GLM-OK

`cli/fleet.ts:1825,1845`. Pure core `runTaskStateTransition` is tested
with injected fetches (`test/studio.task-state.test.ts:24`); the REAL
halves are not. Untested: fetchCurrent's no-single-state-label 409
(:1833-1840 — "carries no single board state label (labels: ...)" plus
the `--from-none` repair hint), fetchTransition's "wrote the transition
but returned no single state label back" 500 (:1855-1859), both !res.ok
slices (:1831, :1853) — the operator's only repair instruction for an
interrupted transition. Proposed — bun lane, pattern (a): spawn `fleet
task state 12 completed` against a stand-in whose GET `/tasks/12`
returns `state: null` with multiple labels; assert exit 1 and the exact
409 message naming the labels and the hint; a second case with the POST
answering 200 with `state: null` asserts the "returned no single state
label" message and exit 1.

### S11-F5. `cmdTaskReap` — both halves' print loops — GLM-OK

`cli/fleet.ts:1899`, dispatched :3035. `reapTerminalAll` IS tested
(`test/cli.reap-terminal.test.ts:15`); the cmd's print loops are not.
Untested: terminal half's "(--apply)/(dry-run)" header :1909, "(no open
issue in a terminal state)" :1910, per-result `#n (state): outcome as
reason — error` :1912, "N left: a page closed nothing" :1914; plain
half's header :1923-1925, skipped vs PR-shaped lines ("#n: skipped —
reason" vs "#n (PR #m): outcome — sha8") :1930-1936, "(no open tasks)"
:1927. Proposed — bun lane, pattern (a): spawn against a stand-in
answering POST `/studio/board/tasks/reap`: one `--terminal` run with
results plus `remaining > 0` (the "N left" line), one empty (the empty
line), one plain run with mixed skipped/PR outcomes asserting both
line shapes exactly, exit 0.

### S11-F6. `cmdTaskJuniorSweep` + `cmdRescueGc` print loops — GLM-OK

`cli/fleet.ts:1943,1966`. Both pure helpers tested (`sweepAllPages`:
`test/cli.junior-sweep.test.ts:12`; GC rule:
`test/bun/rescue-gc.test.ts:44`); the cmd halves are not. Untested:
junior-sweep's "(--apply)/(dry-run)" header :1952, "(no junior
records)" :1954, per-result "#n: outcome — reason" :1957; rescue-gc's
header "(--apply)/(dry-run) — repo @ branch, older than N days"
:1975-1977, "(no fleet/rescue/* branches)" :1979, per-branch "branch:
outcome — reason" :1982. Not rescue behavior: the cmd prints the
route's answers; the rescue rule stays excluded. Proposed — bun lane,
pattern (a): spawn against a stand-in answering POST
`/studio/board/tasks/junior-sweep` and `/tasks/rescue-gc` with shaped
bodies; assert exact lines for a results-bearing and an empty body, and
that the apply flag round-trips into the request body JSON (apply:false
default, apply:true with `--apply`).

### S11-F7. `cmdCheck`/`cmdClearSessionGuard` — the wiring is untested — GLM-OK

`cli/fleet.ts:684,726`. Untested: `cmdCheck`'s `repairFailureLine`
failure posture (exit 1, :689-692), "answered 200 but the body was not
a studio row" refusal (exit 1, :694-697), success prints (one-row table
+ optional full-ERROR line + `READY_CAVEAT`, :698-701);
`cmdClearSessionGuard`'s success print :740-743, two refusal postures
:731-739. `repairFailureLine` itself is tested
(`test/cli.repair-failure.test.ts:24`); the wiring is not — including
`READY_CAVEAT`, which no test anywhere greps. NOT auth/credential:
repair verbs over the same `studioUrl`/`accessHeaders` posture every
tested verb uses. Proposed — bun lane, pattern (a): spawn against a
stand-in answering POST `/studio/<id>/check` and
`/clear-session-guard`; happy path asserts table + caveat on stdout; a
500 asserts exit 1 plus `repairFailureLine`'s exact "fleet check"/
"fleet clear-session-guard" wording; a 200 non-row body asserts the
refusal.

### S11-F8. `parseReapState` — tested only indirectly — GLM-OK

`cli/fleet.ts:2385`, exported. Only indirect coverage:
`test/bun/fleet-reap-wiring.test.ts:146-158` writes corrupt/wrong-typed
state files and asserts kept-aside, proving the null return for exactly
those two inputs. Directly untested: non-object JSON (`"5"`,
`"\"x\""` — the kept-aside test uses only `{not json` and a wrong-types
object), Array input (`Array.isArray` return, :2392), per-field
partial shapes — a file with ONLY a valid `backoffUntil` is kept while
the others default (:2395-2399). Proposed — pattern (b), bun:test
importing `parseReapState` from `../../cli/fleet` (vitest cannot import
`cli/fleet`), table-driven: a valid partial object returns the merged
empty-defaults state; `"[1,2]"`, `"42"`, `"\"str\""` each return null;
each single bad field returns null; kept-aside stays as the integration
half.

### S11-F9. `attachTitleState`, `titleSequence`, `hhmmssZ` — zero direct tests — GLM-OK

`cli/attach-liveness.ts:39,50,19`; `attachTitle` itself IS tested
(`test/bun/attach-liveness.test.ts:186`). `attachTitleState` is
load-bearing: `cli/orca-workspace.ts:311,373,974` use it to decide
whether an Orca terminal is an attach terminal and whether it is stale —
a reworded title must fail closed (null, :44-46), the waiting/live/
stale round-trip must hold; `hhmmssZ` feeds the STALE title's "since
HH:MM:SSZ" rendering. Module imports nothing (checked), so vitest CAN
import it, same lane as `test/cli.input.test.ts`. Proposed — pure
direct unit test: round-trip `attachTitleState(id, attachTitle(id,
"waiting")) === "waiting"`, same for "live"; a stale title with real
since/now round-trips to "stale"; a reworded prefix ("Fleet "
capitalized) returns null; `titleSequence(t)` is exactly
`\x1b]0;${t}\x07`; `hhmmssZ(0) === "00:00:00Z"` and a known epoch
slices to the UTC clock. No bun lane.

### S11-F10. `grabClipboardPng` — zero coverage anywhere — GLM-OK

`cli/paste-mac.ts:20`, exported; referenced only by `cli/fleet.ts:2650`
(`fleet paste`) and `:2733` (attach's ctrl-v intercept). Three
behaviors: pngpaste ENOENT (not installed) returns null (:32-37), a
nonzero pngpaste exit (no image) returns null (:24), a zero exit
returns the written file's bytes and deletes the tmp file (:26-31;
fixed path `/tmp/fleet-paste.png`, :11). Worker paste storage is tested
(`test/studio.paste.test.ts`); the Mac-side probe is not. Proposed —
bun lane (module uses `Bun.spawn` + `Bun.file`): PATH stripped of
pngpaste returns null; a fake `pngpaste` shell script on PATH that
exits 1 returns null; a fake that writes a known byte payload to
`argv[1]` and exits 0 returns exactly those bytes, tmp file gone
afterward. The fake-binary PATH swap is the only platform trick needed
— no Mac required, because the module shells out rather than calling
NSPasteboard.

## Summary

| # | finding | tier |
|--:|---|---|
| 1 | cmdAccountsHold/cmdAccountsClear | GLM-OK |
| 2 | cmdMemoryLs/cmdMemoryCompact | GLM-OK |
| 3 | cmdTaskVerify print loop | GLM-OK |
| 4 | taskStateFetchCurrent/Transition | GLM-OK |
| 5 | cmdTaskReap print loops | GLM-OK |
| 6 | junior-sweep/rescue-gc print loops | GLM-OK |
| 7 | cmdCheck/cmdClearSessionGuard | GLM-OK |
| 8 | parseReapState direct branches | GLM-OK |
| 9 | attachTitleState/titleSequence/hhmmssZ | GLM-OK |
| 10 | grabClipboardPng | GLM-OK |

10 GLM-OK, 0 CLAUDE-ONLY filed (auth, secrets, credentials, rescue,
failover, accounts routing, deploy excluded per the brief, nothing filed).
