# Flaky tests — sweep 8 (2026-10-12, refs #424)

Scope: `apps/fleet/test` — timing-dependent tests. The :220 flake itself is fixed in this PR (production 20-try budget); findings below are further batches, one issue per fix. All line numbers from the cited files at main @ c2cc15f.

## Findings

**S8-F1 — attach-liveness.test.ts:141,151,159,173,181 — fixed `Bun.sleep` waits after spawning a real attach process.**
Why flaky: each test sleeps a hardcoded 3-5s then asserts output that arrives asynchronously from a spawned CLI. On a loaded runner the 5s budget can elapse before the child flushes; conversely the sleeps also set the suite's floor (~20s of pure waiting). Real-world async output, no condition-based wait, no failure-message capture at the assertion site.
Proposed fix: poll the captured stdout/stderr (the harness already stores it) with a deadline loop — condition-based waiting, one helper for the file; assert on the settled state, keep timeouts as bounds not sleeps. Tier: GLM-OK.

**S8-F2 — localci-daemon.test.ts:132 — poll-floor test relies on wall-clock 3.5s sleep.**
Why flaky: asserts exactly one `gh pr list` in 3.5s with `LOCALCI_POLL=1` clamped to a 30s floor. Under load, the daemon's loop iteration can stretch so the second poll lands just after the read; under generous scheduling the test also burns 3.5s regardless. The 30s floor is in the code under test, but the test samples the log once at a fixed time instead of asserting on the poll loop's own deadline.
Proposed fix: read the daemon's poll timestamps from the calls file with a waitFor(deadline > 30s) — count polls within a bounded window (e.g. 4s) and assert the inter-poll gap is >= the floor, or simply assert no second poll before t+30s by checking the daemon's own sleep marker if the script emits one. Tier: GLM-OK.

**S8-F3 — ego-browser-idle-shutdown*.test.ts (3 files) — `Bun.sleep(SIMULATED_LOAD_MS)` before idle assertions.**
Why flaky: three files drive a real Chromium daemon with `EGO_BROWSER_IDLE_MS=400/800` and sleep `3*IDLE_MS` to let the idle window elapse, then assert the daemon exited. The 3x multiple has no failure-mode analysis: a loaded host can take longer than 1.2s/2.4s from last-space-close to pidfile removal. Two of the three files DO have a `waitFor` helper — the sleeps bypass it.
Proposed fix: replace the fixed sleeps with the existing `waitFor(() => !existsSync(pidFile), generous deadline)` shape everywhere in these three files (container test already does this for the second round; align the first rounds and the two sibling files). Tier: GLM-OK.

**S8-F4 — rescue-push.test.ts:676 — 1.1s sleep crossing a 1-second ref-timestamp boundary.**
Why flaky: run2 pushes nothing because the rescue ref name embeds `date -u +%Y%m%d%H%M%S` (rescue.ts:982,987) and the same ref already exists; the test sleeps 1100ms to guarantee a new second. The REAL invariant is "no duplicate push of an already-pushed ref", not "a second has passed" — on a slow host git can take >1s anyway, and on a fast one the sleep wastes 1.1s.
Proposed fix: assert on the dedup invariant directly: run2 with the SAME upstream state must print no RESCUE_PUSHED and leave refs unchanged — the timestamp sleep is incidental; if the ref name must differ, stub `date` in the harness bin (the file already pins fake tooling) rather than sleeping across the boundary. Tier: GLM-OK.

**S8-F5 — orca-workspace.test.ts:1318,1322 — 10ms/50ms sleeps around an exclusive-create lock race.**
Why flaky: the lock test gives the first lock-holder a 10ms head start to win the O_CREAT|O_EXCL race and then sleeps 50ms to prove the second is still waiting. 10ms does not guarantee acquisition under load — if the second caller wins the create instead, `order` reads `["second-acquired","first-acquired"]` and the assertion fails. The comment even names the race.
Proposed fix: replace the 10ms head start with a deterministic gate — have the first holder touch a marker file after acquiring (inside the callback) and waitFor(marker) before starting the second; keep the 50ms as a waitFor on "second NOT acquired" with a deadline instead of a flat sleep. Tier: GLM-OK.

**S8-F6 — rescue-all-scope.test.ts:261-262 — parallelism proven by a 250ms wall-clock bound.**
Why flaky: three fake rescues take 80/150/80ms; the test asserts total < 250ms to prove parallel over sequential (~310ms). A loaded scheduler can inflate event-loop dispatch so even truly-parallel execution exceeds 250ms — the test fails while the production code is correct. Margins are 60ms on a 310ms budget.
Proposed fix: assert on ORDERING evidence instead of wall time: record start/end timestamps inside each fake rescueStudio and assert the three intervals overlap (all started before the slowest ended) — parallelism, provable without a wall-clock race. Tier: GLM-OK.

**S8-F7 — ff-new-race.test.ts:22 — 5ms setTimeout simulating spawn latency in a race regression test.**
Why flaky: the 5ms delay exists to make the stale-listing race reproduce deterministically (two concurrent --new callers). Under Bun's event loop the 5ms is enough on an idle box; a GC pause or loaded core can invert completion order, so the loser/winner labels swap and the test's expected-409 may see the adopt path instead.
Proposed fix: gate both callers on an explicit barrier: have the spawn fake await a promise the test resolves after both callers have read their decision — the race is then staged by construction, not by hoping 5ms is "a while". Tier: GLM-OK.

**S8-F8 — memguard-docker.test.ts:140,160,170,172 — fixed sleeps around process-tree and OOM-adj transitions inside the container script.**
Why flaky: sleeps 1.5s (guard settle), 5.5s (OOM scan window), 1s/30s (idle-tick measurement). All measure OS-process transitions with no re-check loop: a loaded CI Docker runner stretching fork/exec past 1.5s makes `guard_count` read before the second guard region completes; the 30s tick window already carries a control, but the marker waits (`seq 1 100` loops at :155-156) show the file's own better pattern.
Proposed fix: replace the three bare sleeps with the file's own `seq N; condition; sleep 0.05` condition-loops (already used at :155-156), bounded by a deadline and failing with the observed state on timeout. The 30s tick measurement is a measurement, not a race — keep it, but assert on the DIFFERENCE vs the control (already done) and widen nothing. Tier: GLM-OK.

**S8-F9 — bringup-blueprint-sync.test.ts:176-191 — stalled-server timeout proven by `elapsed < 15_000` wall bound.**
Why flaky: sets `BLUEPRINT_SYNC_TIMEOUT=2` against a server that never answers and asserts the whole sync returns in <15s. The 15s bound has 7.5x headroom over the 2s timeout, so a truly hung sync would fail at the test's own 30s bun timeout first or pass misleadingly; under extreme load a correct run (2s timeout + git cleanup) could exceed 15s while being healthy.
Proposed fix: bound is the wrong tool — assert the ERROR MESSAGE the timeout produces (`blueprint refresh failed` / `clone failed`) and that the old checkout survived; keep one generous wall bound only if CI ever needs the hang-guard (then 2x the timeout budget, not 15s). Tier: GLM-OK.

**S8-F10 — deploy-ops-guard.test.ts:349-354,395-400 + deploy-rescue-gate.test.ts:870 — wall-clock upper bounds on refusal paths (15s/20s/120s).**
Why flaky: three tests assert a REFUSAL completes under an upper bound (fetch watchdog 2s → <15s; unreachable origin → <20s; log-record freshness → <120s). Upper bounds fail under load while code is correct — the same class as :220 but inverted. The 120s freshness bound on `Date.parse(rec.ts)` also embeds a clock assumption (no injected clock) that breaks if the deploy helper ever runs with a TZ-shifted or skewed clock source.
Proposed fix: for the two refusal tests, keep the watchdog's own error text as the primary assertion and treat the wall bound as the secondary hang-guard with 10x headroom (or drop — the spawnSync timeout already guards a hang). For the freshness assert, compare against a timestamp the test itself took before the deploy call, not `Date.now()` at assert time. Tier: GLM-OK.

## Not findings (checked, judged sound)
- studio-tmux-socket.test.ts / bringup-claude-relaunch.test.ts poll loops — condition-based (waitFor/waitForPane), deadlines generous, failure messages carry observed state.
- session-memory.test.ts:62 — settles GC by agreement between two readings, deadline-bounded; sound under load by design.
- ego-browser-launch-timeout.test.ts — the 40s TREE_KILL_WAIT is a waitFor with deadline, not a flat sleep; override seams (LAUNCH_TIMEOUT_MS) documented.
- exec-deadline / install-cache-security sleeps are inputs to the code under test (the deadline), not synchronization.
- `port: 0` used by every Bun.serve harness — OS-assigned, no port race.
