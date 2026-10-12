# Slow-tests sweep 15 — apps/fleet/test (2026-10-12)

Ref #487. Analysis only, read-only, no code changed, no test edited. Fifteenth maintainability sweep; scope `apps/fleet/test/**` (vitest + bun lanes). Line refs = physical lines at `origin/main` 8ac2a61, paths relative to `apps/fleet/`.

Method: the task asked to rank via `gh run view --log` on a recent main CI run; GitHub Actions is disabled in rafarc21/fleetflare (CI is the local-ci commit status posted by the operator's own daemon), so no run logs exist. Durations below were measured locally on the sweep container, 2026-10-12, one file at a time. They are host-load-sensitive ranking numbers, not pinned contracts.

## Findings

| # | finding | file | measured | proposed |
|--:|---|---|--:|---|
| F1 | four Bun.sleep waits sized 3-4x env thresholds | test/bun/attach-liveness.test.ts | 20.1s file, ~16s sleeps | shrink thresholds+sleeps together |
| F2 | 3.5s sleep proving a 30s poll floor | test/bun/localci-daemon.test.ts:132,140 | 5.6s file | 3_500 -> 1_500 |
| F3 | 2000ms negative wait past idle window | test/bun/ego-browser-idle-shutdown.test.ts:123 | 4.7s file | IDLE_MS 400->200, wait 2000->600 |
| F4 | two Bun.sleep(3xIDLE_MS) load-gap sims | test/bun/ego-browser-idle-shutdown-container.test.ts:129,149 | 6.4s (2 files) | IDLE_MS 400->200 |
| F5 | Bun.sleep(3x800) after failed launch | test/bun/ego-browser-idle-shutdown-launch-failure.test.ts:85 | (same run) | IDLE_MS 800->400 |
| F6 | flat 200ms settle before /proc reads | test/bun/sweep-procs.test.ts:86,134 | ~18s file share | poll for readiness instead |
| F7 | flat 800ms before process-table scan | test/bun/exec-deadline.test.ts:108 | ~5s file share | poll-until-visible; keep real deadlines |
| F8 | 8s child hold outliving the scan | test/bun/install-cache-security.test.ts:821 | 59.0s file, ~8-9s this test | child 8000->4000 |
| F9 | heartbeat tests on real setTimeout | test/junior.route.test.ts:195,207,213 | sub-300ms | vi.useFakeTimers — flake fix |
| F10 | 8x60ms real gaps under a 300ms idle window | test/llm.anthropic-route.test.ts:604,612 | ~0.5s | vi.useFakeTimers — flake fix |
| F11 | wall-time proof of parallel rescue | test/bun/rescue-all-scope.test.ts:262 | 464ms file | keep as-is (recorded) |
| F12 | 3s "still alive" negative sleep | test/bun/bringup-claude-relaunch.test.ts:832 | 78.3s file, ~4s sleeps | 3000->800 |

### F1 — attach-liveness: sleeps sized against already-injectable env thresholds — GLM-OK

Real `fleet attach` subprocess against a local fake Worker; timers cannot be faked across the process boundary — but every wait already races an env knob the CLI honors: `FLEET_ATTACH_STALE_MS: "1500"`, `FLEET_ATTACH_CONNECT_TIMEOUT_MS: "1000"`. The sleeps (5000/4000/4000/4000/3000ms at :141,151,158,173,181) are sized 3-4x the threshold with multi-second settle margins. Proposed: shrink thresholds AND sleeps proportionally together (STALE_MS 1500->250 with sleeps ~1000; T2 CONNECT_TIMEOUT 1000->200 with sleep 4000->800). Assert upgrade-count and reconnect order, never wall-time bounds; the title-format pure test (last one, zero sleeps) stays untouched. Watch the CLI's own reconnect backoff floor — thresholds must stay above it. Estimated save ~12s.

### F2 — localci-daemon: 3.5s sleep proving a 30s poll floor — GLM-OK

`:132` sleeps 3500ms then counts `gh pr list` calls to prove LOCALCI_POLL=1 was clamped to the 30s floor. An unclamped loop would poll again at ~1s, so 1500ms keeps the assertion discriminating (second poll would land before 1500ms when unclamped). `:140`'s 1000ms is a settle, not a discrimination window — keep it. Proposed: 3_500 -> 1_500. Verify by mutation (set the floor to 1 locally; the test must go RED) — that mutation run executes the file twice, budget it as one heavy step. Estimated save ~2.7s.

### F3 — ego-browser idle-shutdown: 2000ms negative wait — GLM-OK

Real daemon + real Chromium subprocess; the idle window is env-injectable (`EGO_BROWSER_IDLE_MS: "400"`). The 2000ms wait at :123 proves the daemon does NOT exit while a space is open — only real time proves a non-event, so keep the mechanism, shrink the window: IDLE_MS 400->200, wait 2000->600 (3x margin kept). waitFor interval 50->25. Estimated save ~1.4s.

### F4 — ego-browser idle-shutdown-container: SIMULATED_LOAD_MS gaps — GLM-OK

`:129,149` two `Bun.sleep(SIMULATED_LOAD_MS)` where SIMULATED_LOAD_MS = 3 x IDLE_MS = 1200ms (#317 loaded-host simulation). Shrinking IDLE_MS 400->200 shrinks both to 600ms; the negative-direction logic is unchanged. waitFor windows (10s/5s) are failure deadlines, not sleeps — they cost ~0 when green. Estimated save ~1.2s.

### F5 — ego-browser idle-shutdown-launch-failure: same shape after a failed launch — GLM-OK

`:85` `Bun.sleep(SIMULATED_LOAD_MS)` = 3 x 800 = 2400ms; IDLE_MS is deliberately higher because a real (failing) chromium.launch() adds wall variance before the timer arms. Shrink IDLE_MS 800->400 -> sleep 1200ms. Estimated save ~1.2s.

### F6 — sweep-procs: flat 200ms settle before /proc reads — GLM-OK

The 200ms at :86/:134 lets argv/cwd/environ become readable in /proc. A fake clock cannot make the kernel expose a process faster. Rewrite: readiness POLL (read /proc/<pid>/cmdline until non-empty, bounded 500ms) — usually settles in <10ms, same property. The kill-wait dead() loops can drop 100->50ms interval. Estimated save ~1.5s, more under load.

### F7 — exec-deadline: one flat 800ms before a process-table scan — GLM-OK

The file's core (real `timeout -k` killing real hung children, measured `r.ms` bounds) is intrinsic — wall time IS the assertion. The one fakeable edge: :108's flat 800ms sleep exists so the scan can catch the wrapper mid-run; rewrite as poll-until-`timeout -k`-visible (100ms interval), THEN assert no token — saves ~700ms on a fast host. Leave the 1000ms kill deadlines alone (halving them halves the contention margin the tests measure). Estimated save ~0.7s.

### F8 — install-cache-security: 8s child hold outliving the scan — GLM-OK

`:821` MUTANT PROOF holds a child (`setTimeout 8000`) for the duration of a /proc scan. The child only needs to outlive the scan; the shipped command is fast uncontended. Shrink to 4000ms — still 4-5x the scan. Do NOT touch the MUTANT BASELINE sibling above it (:802, never-resolving child, 180s contended ceiling) — its child is deliberately unbounded so it can never expire mid-scan. Estimated save ~4s.

### F9 — junior.route heartbeat tests: real setTimeout against an explicit seam — GLM-OK

`:195,207` AI.run mocks resolve via real setTimeout(50)/(200); `:213` sleeps 60ms to let heartbeat ticks fire. The heartbeat interval is ALREADY an explicit argument (rows, 10 = 10ms). vi.useFakeTimers + advanceTimersByTimeAsync makes the three tests deterministic: resolve after one tick; the :213 settle becomes advancing until the existing clearInterval spy fires. Small absolute win (sub-300ms) but removes a real-clock flake under a loaded runner. Proposed as flake-hardening first, speed second.

### F10 — llm.anthropic-route: 8x60ms real gaps under a 300ms window — GLM-OK, the strongest correctness case in the sweep

`:604,612` — one 60ms sleep per pull, 8 pulls (~480ms total) under `LEAD_STREAM_IDLE_MS: "300"`. The relationship 60 < 300 < 480 IS the assertion (per-chunk re-arm lets a slow-but-steady stream through). Under a loaded runner one real gap can stretch past 300ms and the test goes flaky — measured risk, not hypothetical. vi.useFakeTimers + advanceTimersByTimeAsync preserves the exact ordering with zero real time. Fake timers work under vitest-pool-workers (repo precedent: exceptions.test.ts, studio.observation.test.ts — same pool). Estimated save ~0.5s + flake removal.

### F11 — rescue-all-scope: wall time IS the property — recorded, not filed

`:262` setTimeout(80-150ms) inside fakeDeps + the `elapsed < 250ms` assertion prove parallel wall time tracks the max, not the sum. Fake timers would erase the thing asserted. Only possible speedup is shrinking delays and the bound proportionally (150/80->40/20, 250->80; ratio carries the proof) — marginal ~0.2s in an already-cheap 464ms file. Counted, nothing filed.

### F12 — bringup-claude-relaunch: one 3s negative sleep inside an intrinsic file — GLM-OK

`:832` `Bun.sleepSync(3000)` asserts the fake lead is STILL the same process seconds later — a survival property, not a timed event: shrink 3000->800 (same pids alive). The file's real cost is 32 tests x real tmux fork/exec (~74s of 78s) — intrinsic, NOT fakeable; record that honestly. waitForPane/waitForSwallowed sync-poll loops are deadline-bounded polls, not sleeps; a 100->50ms interval halves worst-case detection, saves ~nothing when green. Proposed: the one sleep shrink only, explicitly not a fake-clock rewrite. Estimated save ~2.2s.

## Not filed (deferred / noted)

- test/bun/localci-run.test.ts — 132.4s, heaviest measured. Real docker/git/lane-timeout walls (LOCALCI_LANE_TIMEOUT, 15s SIGTERM budgets): wall time IS the assertion. The honest speedup is shrinking LOCALCI_LANE_TIMEOUT/LOCALCI_KILL_GRACE env knobs the script already exposes — but each test's Date.now() bounds are sized against those knobs' production values, and re-sizing them is what the sweep's no-weakening rule protects. Needs its own careful pass.
- test/bun/rescue-push.test.ts:676 — setTimeout(1100) between run1 and run2 of the idempotence check; 92.7s file across 176 tests, almost all real git clones/pushes (intrinsic). The 1100ms exists to let the ref-timestamp second-resolution tick over (rescue refs embed YYYYMMDDHHMMSS). Replaceable by pinning `date` via a PATH shim — the file's own sibling C4 test already uses that exact shim pattern. ~1.1s, mechanical. Counted, not filed: rescue is a CLAUDE-adjacent lane and the win is one line in a 92s file.
- test/bun/ego-browser-launch-timeout.test.ts:42 TREE_KILL_WAIT_MS=40000 — a waitFor deadline, costs ~0 green; the real cost there is Playwright's own 30s default wait-before-kill, the file's own comment says so. Not a sleep; not filed.
- test/bun/accounts-cli.test.ts:572 — setTimeout(300) Promise.race in a prompt test; accounts routing is a CLAUDE-ONLY lane even as a test-file edit (sweep-10's tier rule). Counted, not filed.
- test/bun/studio-fleet-directs.test.ts:25 — Bun.sleep(hangMs) hangs on purpose; the hang is the subject. Not filed.
- test/studio.ws.test.ts + studio.ws-own-sockets.test.ts vi.waitFor — already the poll idiom, sub-second. Counted, nothing to do.
- Vitest-lane harness overhead (setup 3-13s, transform 1.5-4.8s per file) dwarfs in-file sleeps on that side — the lane's real cost is pool-workers startup, out of a test-file sweep's scope. Measured: junior.route+fleet-resume 490ms of test bodies in 4.97s wall; studio.ws.test.ts 1.84s in 5.64s wall.

## Counts

12 findings. 11 would each get one `test(GLM-OK): S15-Fn` issue (F1-F10, F12); F11 counted, not filed. No issues filed in this pass — operator stopped the sweep at the 30m review cap; the list above is the filing queue. Estimated bun-lane wall save if all land: ~27s per local run, plus two flake sources removed (F9, F10).
