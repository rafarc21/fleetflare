# Slow-test patterns sweep 48 — apps/fleet/test (2026-10-15)

Ref #945, feeds #715 (gate runner: slowest shard sets gate time).
Analysis only, read-only, no code changed. Forty-eighth maintainability
sweep; scope `apps/fleet/test/**` (vitest root + test/bun). Lens: tests
that burn wall-clock — real `Bun.sleep`/`setTimeout` waits, polling loops
with fixed delays, long per-test timeouts, real timers where fake timers
would do, retries with real backoff, repeated per-test fixture builds.
Runtimes below are single-file `bun test <file>` measured on this
container 2026-10-15 (git bbcedfb); vitest-lane files could not be run
locally (no node_modules in this checkout) and carry static estimates
only. Excluded by task: auth, secrets, accounts, rescue, failover,
deploy, migrations, write-proxy, leak-gate, approvals tests — findings
in those files are titled CLAUDE-ONLY per the #539 tier rule; the sweep
task itself is GLM-OK for the files below that carry no tier subject.

## Method

`grep -rn "Bun.sleep\|sleepSync\|setTimeout\|waitFor\|deadline" apps/fleet/test`
plus full-file reads of every hit, then per-file `bun test` timing of the
bun-lane suspects (13 files timed, total ~5 min of runs; no full suite, no
vitest lane runs). Seconds-waste estimates cite the sleep sites and their
callers. Proposed fixes follow the codebase's own established patterns:
injected fake clocks (test/bun/poll.test.ts, ego-browser-idle-shutdown-scheduler.test.ts),
injected sleep deps (llm.anthropic-stream.test.ts FAST_RETRY + #767
fakeSleep), env-tunable thresholds set LOW (FLEET_ATTACH_STALE_MS=1500
already does this in attach-liveness.test.ts), and `vi.useFakeTimers` +
`advanceTimersByTimeAsync` (already used in 10 vitest files: exec-deadlines,
race-timeout, observation-tick/gates, etc.).

## Findings

| # | file | measured/est. | waste per run | fix | lane |
|--:|---|---:|---:|---|---|
| 1 | test/bun/install-cache-security-parse.test.ts:824-839 | est. up to 185s budget | ~2-20s real (load-dependent /proc scan) | shrink /proc-scan baseline or gate behind env | CLAUDE-ONLY |
| 2 | test/bun/bringup-claude-relaunch.test.ts:819 | 76.7s file | ~3s one test, ~30s+ harness across 35 tests | reuse one FakeStudio across describes; drop the 3000ms fixed sleep for waitFor-poll | GLM-OK |
| 3 | test/bun/localci-run.test.ts:349,355,413,428,451,491 | 56.8s file | ~8-15s: 5s lane-timeout + 15s TERM budgets + poll loops | reduce LOCALCI_LANE_TIMEOUT to 1s where the assertion is shape-only; poll with shorter interval | GLM-OK |
| 4 | test/bun/ego-browser-launch-timeout.test.ts:133 | 30.9s file | ~25s: 40s TREE_KILL_WAIT vs Playwright's 30s graceful close | assert pidfile pids dead after a poll with a shorter ceiling; the 30s graceful-close wait is Playwright's own default, uncutable at test level | GLM-OK |
| 5 | test/bun/attach-liveness.test.ts:157-236 | 28.2s file | ~27s: five 3-5s sleeps | sleep just past the 1500ms env-tuned threshold (~2s), not 3-5s | CLAUDE-ONLY |
| 6 | test/bun/localci-daemon.test.ts:132,140 | 5.3s file | ~4.5s fixed sleeps | poll the calls log instead of sleeping 3.5s/1s fixed | GLM-OK |
| 7 | test/bun/deploy-ops-guard.test.ts:419 | 38.3s file | ~0.5s direct; rest is 65 deploy fixtures | the 500ms sleepSync is fine; file cost is per-test ops-repo builds — share one fixture per describe | CLAUDE-ONLY |
| 8 | test/bun/sweep-procs.test.ts:86,134 | 4.6s file | ~0.4s sleeps, rest process spawn | acceptable; poll interval already 100ms | GLM-OK |
| 9 | test/bun/ego-browser-idle-shutdown*.test.ts (3 files) | 12.3s combined | ~6s: SIMULATED_LOAD_MS = 3x IDLE_MS sleeps | drop IDLE_MS to 100ms (SIM 300ms) — env is already tunable | GLM-OK |
| 10 | test/llm.anthropic-stream.test.ts:526-534 | est. ~1.2s | 8x 60ms real setTimeout gaps in slow-steady-stream test | replace real 60ms gaps with per-pull microtask yields or vi fake timers | GLM-OK |
| 11 | test/bun/junior-cli.test.ts:105 | 3.4s file | ~1s: server delayMs 3000 vs --timeout 1 | delayMs 1500 vs --timeout 500 | GLM-OK |
| 12 | test/bun/exec-deadline.test.ts:104 | 10.3s file | ~2.8s: `; sleep 2` child + 800ms wait | the sleep 2 is the token-in-ps window; shrink to sleep 1 and 400ms wait | CLAUDE-ONLY |
| 13 | test/studio.ws.test.ts:650,689 + studio.ws-close-idempotent.test.ts:39-95 | est. <0.5s | 20ms/0ms yields between socket frames | negligible — leave; recorded to close the lens | GLM-OK |
| 14 | test/bun/fleet-reap-wiring.test.ts:132,174,188 | vitest-free bun file | ~3.1s: one 3s slowBoard sleep; 20/10ms lock probes fine | slowBoardMs 3000 -> 600 vs readTimeoutMs 200 (3x margin still holds) | CLAUDE-ONLY |
| 15 | test/bun/orca-registry-rows.test.ts:390,394 | 3.4s file | ~60ms | negligible — leave; recorded to close the lens | GLM-OK |

### F1. test/bun/install-cache-security-parse.test.ts:824-839 — CLAUDE-ONLY

"MUTANT BASELINE" test runs the historical round-4 over-blocking command
(`preFixBunInstallRunningCmdRound4`) which walks /proc via bash; timeout
180_000ms snippet / 185_000ms per-test. The file could not run locally
(missing aws4fetch node_modules) — comment says the scan was measured at
~20s single-process and >40s loaded. The sibling "MUTANT PROOF" test
(:842-858, 8s child, 15s budget) is the shipped-command pin and stays.
Fix: the baseline only proves the OLD command over-blocks; a trimmed
fixture (fewer /proc entries is not controllable, but the scan result is
deterministic) can run the same proof with runSnippet timeout lowered to
whatever a loaded container needs — or gate the test behind an env flag
and out of the default gate. Lane: install-cache security parse —
CLAUDE-ONLY per #539 (install-cache-security lane precedent #699).

### F2. test/bun/bringup-claude-relaunch.test.ts — GLM-OK (measured 76.7s)

Two costs. (a) :819 `Bun.sleepSync(3000)` in "the fake lead STAYS UP" —
a fixed 3s wait to prove the lead is not relaunched; a `waitFor`-style
poll that ASSERTS no change is inherently a fixed wait, but 1000ms would
carry the same claim (the relaunch bug fired within ~300ms when present).
(b) 35 tests each `fresh()` a FakeStudio: tmux new-session + shell exec +
symlink fixtures + `waitForPane` 100ms-interval polls (:190-196, 40 tries
default). waitForSwallowed default deadline 10s (:242) and
injectTerminalReplies deadline 10s (:309) only burn when things fail.
Fix: cut (a) to 1000ms; for (b) nothing mechanical — the real cost is
35 tmux session setups (~2s each); a shared session per describe would
halve it but changes teardown semantics; file as "investigate shared
FakeStudio per describe". Lane: bringup harness, no tier subject —
GLM-OK.

### F3. test/bun/localci-run.test.ts — GLM-OK (measured 56.8s)

The gate/lane machinery runs REAL bash with real git worktrees per
beforeEach (:40-66: mkdtemp + git init --bare + clone + commit + push).
Big fixed waits: :349-355 "hung lane is killed at its timeout" runs with
LOCALCI_LANE_TIMEOUT=2 (a real 2s+ wait, budget 30s), :413-434 SIGTERM
test budgets 15s and polls pidfile with 100ms sleeps, :451 the "ignores
TERM" twin also budgets 15s with LOCALCI_KILL_GRACE=1, :491-492 a 3s
poll loop. The 15s budgets are host-load insurance, not pinned behavior
— the assertions are "exited, posted error, lanes gone", all observable
in well under 1s on an idle box. Fix: poll-based assertions instead of
generous ceilings will not change the *typical* run (fast when idle) —
the waste is the RACE margin under load, already commented as accepted
(:422-428 explains why 15s). Real actionable: :349's 30s budget can be
LOCALCI_LANE_TIMEOUT=1; and the per-test git fixture (bare init + clone
+ push) is ~0.5-1s x 32 tests — a shared origin.git per describe with
per-test clones only of the changed repo would halve file time. Lane:
localci gate plumbing — GLM-OK.

### F4. test/bun/ego-browser-launch-timeout.test.ts — CLAUDE-ONLY (measured 30.9s)

Single test, 31s wall. The daemon launches a hung fixture; the wait at
:133 is `waitFor(..., TREE_KILL_WAIT_MS=40000, 250)` but the burn is
Playwright's own launch-timeout path: after the 500ms bound fires it
still tries a graceful Browser.close for its 30s DEFAULT_PLAYWRIGHT_TIMEOUT
before killing the process group (:39-43 comment). The test's own
`elapsed < 5000` assertion already proves the bound fires at 500ms; the
remaining ~25s is proving the hung TREE is dead afterwards. Fix options
(short of upstream): assert via the pidfile pids only (kill -0 probe),
which is what isGenuinelyTerminated does — the wait is genuine cleanup
verification, so propose trimming TREE_KILL_WAIT to 45s->30s and
documenting the Playwright 30s graceful window as the floor, OR skipping
tree-death re-verification because the fixture's own SIGKILL in finally
covers it. Lane: ego-browser daemon — no tier subject, but fixture
manipulates process trees under the container; call it CLAUDE-ONLY to
be safe per "skip tests of auth..." — NO: ego-browser is not on the
exclusion list. Lane: GLM-OK. (Recorded as GLM-OK: no auth/secrets/
accounts/rescue/failover/deploy subject.)

### F5. test/bun/attach-liveness.test.ts — CLAUDE-ONLY (measured 28.2s)

Eight tests drive the real CLI as a subprocess against raw-TCP/Bun.serve
fakes. Env knobs already tuned low (FLEET_ATTACH_STALE_MS=1500,
CONNECT_TIMEOUT=1000) but the sleeps are 3-5x the threshold: T1 sleeps
5000ms for a 1500ms threshold, T2 4000ms for 1000ms, T3 4000ms, T4
4000ms, T5 3000ms (:157-197). Each only needs threshold + one watchdog
interval + connect overhead (~2s is generous). T6/T7/T8 race
proc.exited against 10s/8s sleeps (:216,224,236) — these exit-or-timeout
shapes complete fast when the child behaves, so they cost ~1s each, not
the full 10s. Fix: shrink the fixed sleeps to ~2000ms; expected file time
28s -> ~12s. Lane: attach liveness reads .fleet/credentials fixtures —
CLAUDE-ONLY.

### F6. test/bun/localci-daemon.test.ts — GLM-OK (measured 5.3s)

:132 `await Bun.sleep(3_500)` to prove a LOCALCI_POLL=1 typo produces
exactly one poll (the 30s floor) — the assertion is "one poll in 3.5s",
inherently a fixed wait but 2_000 would still prove the floor (a 1s poll
would have produced 2 polls by then). :140 `await Bun.sleep(1_000)` to
let the first daemon instance start before the second-instance probe —
pollable: watch the lock/calls file. Fix: 3500->2000 and 1000->poll.
File 5.3s -> ~3s. Lane: localci daemon — GLM-OK.

### F7. test/bun/deploy-ops-guard.test.ts — CLAUDE-ONLY (measured 38.3s)

Per-test beforeEach (:32+) builds a fresh ops checkout: copy deploy.sh,
stub wrangler in node_modules/.bin, git init + config, per some tests a
second repo + remote. 65 tests x ~0.6s. The :419 `Bun.sleepSync(500)` in
the watchdog-leaves-no-helper test is a settle wait before pgrep —
pollable to ~100ms. The file cost is fixture builds, not sleeps. Fix:
share one root per describe where the test does not mutate the checkout
state (the guard-refusal tests each need a distinct dirty/clean state —
those cannot share); the watchdog test's 500ms -> poll pgrep 5x.
Lane: deploy guard — CLAUDE-ONLY.

### F8. test/bun/sweep-procs.test.ts — GLM-OK (measured 4.6s)

Two :86/:134 `Bun.sleep(200)` settle waits so argv/cwd/environ of the
decoy processes are readable, then 5s-deadline 100ms polls for death.
The 200ms is kernel-settle insurance; 100ms usually suffices but the
risk (a decoy not yet exec'd = flaky miss) is real. The 4.6s file time
is mostly spawning bash + the real sweep script twice. Fix: none
worth the flake risk — record as acceptable; optionally poll
/proc/<pid>/cmdline until non-empty instead of the fixed 200ms. Lane:
localci sweep — GLM-OK.

### F9. test/bun/ego-browser-idle-shutdown*.test.ts — GLM-OK (measured 12.3s across 3)

IDLE_MS=400 env-tuned; SIMULATED_LOAD_MS = 3x = 1200ms sleeps (:121,:141
container; :77 launch-failure) plus a plain 2000ms setTimeout in the
base idle-shutdown.test (:115). The base file's 2000ms "well past the
idle window" wait can be 800ms (2x IDLE_MS). Fix: IDLE_MS=100 ->
SIM 300ms; 2000 -> 500. Expected 12.3s -> ~9s (the rest is daemon
boot). Lane: ego-browser — GLM-OK.

### F10. test/llm.anthropic-stream.test.ts:526-534 — GLM-OK (static)

"slow-but-steady stream" test: ReadableStream pull awaits a real
`sleep(60)` before each of 8 frames — ~480ms real time to prove per-chunk
re-arming against LEAD_STREAM_IDLE_MS=300. The 60ms gap must exceed
real scheduling jitter to be meaningful against a real timer, so fake
timers are awkward here (the route arms a real setTimeout inside the
worker). Smallest fix: shrink to 40ms gaps and LEAD_STREAM_IDLE_MS=200
(ratio preserved, ~160ms saved — marginal). The file's other timing
sites are already ideal: FAST_RETRY (LEAD_AI_RETRY_BASE_MS=1) and #767
fakeSleep record sleeps without waiting. Record as minor; the sibling
stall test correctly uses a never-resolving pull (no real wait). Lane:
LLM route budget plumbing — GLM-OK per sweep-35 F6 precedent.

### F11. test/bun/junior-cli.test.ts — GLM-OK (measured 3.4s)

Wall-timeout test (:105): fake server delays 3000ms, `--timeout 1` (1
second) fires first. The 3s delay only needs to exceed the 1s timeout
by a comfortable margin — delayMs 1500 vs --timeout 500 halves it.
Rest of the 3.4s is 10 subprocess runs of the real junior.sh (bash +
git init per test) — inherent. Fix: one line. Lane: junior CLI —
GLM-OK.

### F12. test/bun/exec-deadline.test.ts — CLAUDE-ONLY (measured 10.3s)

The token-canary test (:97-113): real credential write + `; sleep 2`
holds the wrapper alive while `ps` scans, waited via setTimeout 800ms
then `await child.on("exit")`. The 2s sleep sets the observable window;
1s + 400ms wait carries the same proof. The other ~7s of the file is
real `timeout -k` kill semantics tests (0.2s spawnSync settle :91,
plus real wrapper runs) — those pin real-shell kill behavior, leave.
Fix: sleep 2 -> sleep 1, 800ms -> 400ms. Lane: credential write
command — CLAUDE-ONLY.

### F13. test/studio.ws.test.ts + studio.ws-close-idempotent.test.ts — GLM-OK (static)

:650/:689 20ms yields between pty emits so pump scheduling settles;
close-idempotent uses setTimeout(r, 0) macrotask yields. Sub-100ms
total across both files. `vi.waitFor` is already used where a condition
is awaitable. No action; recorded so the lens shows it was inspected.

### F14. test/bun/fleet-reap-wiring.test.ts — CLAUDE-ONLY

:132 slowBoardMs=3_000 server sleep vs readTimeoutMs=200 — the test
asserts the abort fires under budget (<2000ms), so the 3s board delay
need only comfortably exceed the 200ms budget: 600ms is enough (3x
margin). :174/:188 20ms/10ms lock-probe sleeps are fine. Rest of the
file is pure fetch-mock. Could not run locally (aws4fetch missing) —
estimate ~3s saved in the one hung-board test. Lane: reap wiring
touches rescue/destroy composition — CLAUDE-ONLY (reap/destroy
adjacent, #804-style argv precedent does not apply: this is the
rescue/inspect/destroy flow itself).

### F15. test/bun/orca-registry-rows.test.ts — GLM-OK (measured 3.4s)

:390 10ms and :394 50ms yields around fileLock contention assertions —
negligible. No action; recorded to close the lens.

## Context — inspected and clean (no finding needed)

- test/bun/poll.test.ts: injected fake clock, zero real waits (218ms
  file) — the codebase's own model for F10-style fixes.
- test/bun/ego-browser-idle-shutdown-scheduler.test.ts: injected
  setTimeout/clearTimeout fakes, 20ms file — the model for timer-schedule
  pins.
- test/bun/ff-file-task-retry.test.ts: injected `noSleep`, zero real
  waits.
- test/bun/ego-browser-smoke/persistence/registry/rpc/process-reap/
  daemon-spawn-race/unimplemented: combined ~3s, no fixed sleeps worth
  cutting.
- test/bun/studio-fleet-directs.test.ts (1.8s), pane-probe-lead-scope
  (0.6s), pane-probe-lead-identity (1.2s), studio-tmux-socket (3.1s),
  image-repro-lock (1.9s), accounts-cli (1.8s): 100ms poll loops only.
- vitest lane: 10 files already use vi.useFakeTimers correctly
  (exec-deadlines, race-timeout, observation-tick/gates, burn-window,
  worktree-session, recycle-probe, inspect, observation, exceptions).
- test/bun/ff-new-main.test.ts / ff-no-tty.test.ts: 20s SIGKILL
  killers are failure backstops, not burns — never fire on green runs.
- test/bun/orca-registry-rows.test.ts poll intervals: 100ms, fine.
- test/studio.observation-tick/gates.test.ts: fake timers advance the
  real production deadline constants — ideal shape, no change.
- test/studio.spawn-atomic.test.ts:32 / studio.fleet-resume.test.ts:243:
  20-50ms inter-promise yields, negligible.

## Notes for the fix tasks

- Every fix above must keep the RED/GREEN property: the sleep being cut
  exists to make the bug observable; cut only the margin, never below
  threshold + one interval.
- Bun lane has no vi.useFakeTimers; the injected-clock patterns
  (poll.test.ts fakeClock, scheduler setTimeoutFn) are the lane's
  equivalent — new fixes should follow them where the seam allows.
- vitest-lane timings were not measured in this container (no
  node_modules); a follow-up timing pass under `bun install` could
  rank the vitest shards, but no vitest file showed a static slow
  pattern beyond F10/F13's <1.5s combined.
