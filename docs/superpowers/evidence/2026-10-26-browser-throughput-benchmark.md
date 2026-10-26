# Gate browser suite THROUGHPUT benchmark — in-container parallel vs gate shards vs preview deploy + Browser Run fan-out

Board #1364. Refs #1347, #1134. v1 (#1347) measured per-run latency only
(in-container 136 ms p50 vs Browser Run 272 ms). This measures WHOLE-SUITE
wall time: does concurrency beat per-run slowness? A 50-spec Playwright
fixture suite against a small fixture app (multi-page, fetches, one 2-account
spec with isolated data) + a harness that targets any base URL.

## Verdict up front

**One container at k=4 workers is the default for a 50-spec browser suite.
Gate sharding (B) buys nothing — boot dominates. Browser Run fan-out (C) at
k=50 loses outright (4.6× A); only C at k≤10 inside the burst bucket beats A
on suite wall alone, and it still loses per-PR end-to-end once the 13.7 s
preview deploy is paid. Keep A k=4; use C only where a deploy already
happens (post-deploy check), k≤10 sessions.**

Side by side (A measured, B modeled, C measured by maestro — full C raw in
issue #1364 comment 6416784180):

| config | n | suite wall p50 | p95 | per-spec p50 | flakes | setup | $/suite |
|---|---|---|---|---|---|---|---|
| A k=4 (in-container) | 5 | 3997 ms (+497 boot) | 4446 ms | 80 ms | 0/250 | 0 (gate container already up) | ~$0.066 (1 container leg) |
| B N=1..8 shards (modeled) | — | 69.5–73 s @60 s cold | 99.5–103 s @90 s | — | — | 39–99 s per shard | $0.066 × N |
| C k=50, 334 ms stagger | 5 | 18515 ms | 19804 ms | 433 ms | 0/250 | 13.7 s preview deploy | $0.0011 browser-h + $80/mo concurrency |
| C k=50, no stagger (burst) | 1 | 12934 ms | — | 422 ms | 5/50 (429 launch fail) | 13.7 s | same |
| C k=20, 334 ms stagger | 1 | 9673 ms | — | 308 ms | 0/50 | 13.7 s | ~$0.0008 + $20/mo |
| C k=10, 334 ms stagger | 1 | 7939 ms | — | 340 ms | 0/50 | 13.7 s | ~$0.0006 |
| C k=10, no stagger | 3 | 2835 ms | 5319 ms | 277 ms | 0/150 | 13.7 s | ~$0.0005, $0 concurrency |

Config A (5 suite runs each, 50 specs, 0 flake):

| k (workers, one container) | suite wall p50 | p95 | boot p50 | flake |
|---|---|---|---|---|
| 1 | 7245 ms | 7635 ms | 166 ms | 0 |
| 2 | 5038 ms | 5296 ms | 297 ms | 0 |
| **4** | **3997 ms** | **4446 ms** | **497 ms** | **0** |
| 8 | 3730 ms | 4070 ms | 1073 ms | 0 |

CPU knee at **k=4**: wall falls 7245 → 3997 ms (1.8×) from k=1 to k=4, then
only 3997 → 3730 ms (7%) to k=8 while boot doubles (497 → 1073 ms). The
container is 4 vCPU, so k=4 saturates it — k=8 oversubscribes, and its p95
variance rises.

Config B (modeled, 30/60/90 s cold-start span): sharding a ~4 s suite is a
loss. Compute term shrinks 1/N (4.0 s → 0.5 s at N=8), but per-container
boot+setup is paid N times (39–99 s) and dominates: N=8 saves ~3.5 s of
compute against 39–99 s of new overhead, at 8× cost. Sharding pays only when
compute >> boot — true for the 674 s bun-test lane, false for a 4 s browser
suite.

Config C (measured, not just modeled): the 3 new/s acquisition floor is real
and is the whole story. `limits()` reports `allowedBrowserAcquisitions 10`
(a burst bucket) then ~3 new/s. A 50-session fan-out pays a ~17 s ramp to
acquire the sessions; bursting past the 10-session bucket turns the ramp into
429 flakes (5/50 specs failed in the burst run). Per-spec work is also
3.5–5.4× slower than A (277–433 ms vs 80 ms) because every step crosses
browser → app Worker → Durable Object. So k=50 is 4.6× A on suite wall.

## What was measured (config A, in-container)

50 specs: 48 single-account specs (24 counter + 24 item, unique account ids
`a1..a24`), one 2-account isolation spec (`iso-w` writes, `iso-r` must see
nothing), one multi-page spec (home → /list). Every spec hits real app state
(bump counter / POST item / fetch list), none are pure DOM reads. Fixture is
a `Bun.serve` app with per-account in-memory state; `/reset` clears between
suite runs so every run is independent.

Harness (`harness.ts`): k workers pull the next spec off a shared index; one
browser, k contexts, one page per worker (reused across the specs it gets).
Suite wall = wall clock for all 50 specs; per-spec walls also recorded.
Each k ran in its own fresh process (one browser per k, reused across the 5
runs = warm-gate-container shape). Raw: `scripts/bench/browser-throughput/out/config-a/`.

| metric | k=1 | k=2 | k=4 | k=8 |
|---|---|---|---|---|
| wall p50 (ms) | 7245 | 5038 | 3997 | 3730 |
| wall p95 (ms) | 7635 | 5296 | 4446 | 4070 |
| wall min/max | 6910/7635 | 4662/5296 | 3642/4446 | 3492/4070 |
| boot p50 (ms) | 166 | 297 | 497 | 1073 |
| flake rate | 0/250 | 0/250 | 0/250 | 0/250 |

Chromium 153.0.8010.12, playwright-core 1.63.0 — same binary/version the gate
`e2e` image bakes. Container: 4 vCPU, ~11 GB (the 11.6 GiB ceiling).

**Data-isolation risk: zero in config A.** Fixture isolates by account id in
a single in-memory Map; each spec owns a disjoint id set, and the isolation
spec passed 0 flakes across all 20 suite runs (5 × 4 k). The only hazard is
reusing an account id (a bug, not a concurrency property) — specs use
`a1..a24` and `iso-w`/`iso-r`, disjoint on purpose.

## Config B — gate shards (modeled, not measured)

No measured CF-container cold-start number exists; the design doc
(`docs/superpowers/specs/2026-10-15-gate-runner-design.md:227`) says "≤60 s
assumed, unmeasured on CF containers," and the one measured fact is an
image-pull cold host >60 s (`apps/fleet/src/gate/run-leg.ts` PORT_RETRY_BUDGET
comment). So B is a model over a 30–90 s cold span, not a claim. Formula:

```
suite wall(N) = cold + checkout(5s) + install(4s) + configA_k4 / N
```

| N | wall @30s cold | wall @60s | wall @90s | cost (N × $0.066) |
|---|---|---|---|---|
| 1 | 43.0 s | 73.0 s | 103.0 s | $0.066 |
| 2 | 41.0 s | 71.0 s | 101.0 s | $0.132 |
| 4 | 40.0 s | 70.0 s | 100.0 s | $0.264 |
| 8 | 39.5 s | 69.5 s | 99.5 s | $0.528 |

Compute term (configA_k4 / N) collapses to 0.5 s at N=8, while boot+setup is
paid per container and dominates every row. More shards = 8× cost for ~3.5 s
of wall. Sharding is the right shape for the 674 s bun-test lane (compute >>>
boot); it is the wrong shape for a browser suite whose whole compute is 4 s.

## Config C — preview deploy + Browser Run fan-out (measured by maestro)

Measured 2026-10-26 ~13:00Z by the maestro (Mac, browser colo MAD, throwaway
Workers — both deleted, URLs 404 verified). The fixture app was ported 1:1 to
a Worker with state in ONE Durable Object — a per-isolate in-memory Map would
break POST-then-GET across isolates. Runner Worker holds the `browser`
binding (`@cloudflare/playwright@1.3.6`); one runner request = one Browser
Run session, session runs its round-robin share of the same 50 `specs.ts`,
driver in-Worker (not Mac-side CDP). `/reset` before each suite, 15 s gap
between suites. Suite wall = first launch request → last session closed.

The suite is engine-agnostic (same `SpecPage` surface), so config C runs the
IDENTICAL 50 specs over `connectOverCDP`, one session per spec.

**Measured harness was NOT committed (throwaway, by design).** The actual C
run used an in-Worker runner over the `browser` binding, round-robin sessions
per request, and a DO-backed app — throwaway Workers, deleted after the run.
What IS committed is `drivers/browser-run.ts` + `run-c.ts`: an ALTERNATIVE
shape (Mac/container-side `connectOverCDP` directly against the wss endpoint,
one session per spec) that a studio can run if it ever holds a credential. It
is not the exact harness the numbers came from, and its numbers would differ
(session-per-spec fan-out vs round-robin share; Mac-side CDP vs in-Worker
driver). Treat it as a starting point, not the measured apparatus.

**The binding limits, now measured, not doc-read:** `limits()` reports
`maxConcurrentSessions 200` and `allowedBrowserAcquisitions 10` (burst
bucket), then ~3 new/s. So 50 sessions cost a ~17 s acquisition ramp AFTER the
first 10 go through instantly; launch p50 531–599 ms (max 1.0–1.8 s). The
ramp is C's floor for k>10, and it is the wall:

- **k=50, staggered (334 ms):** wall p50 18515 ms, ramp p50 16869 ms, 0/250
  flakes. The ramp IS the suite wall — 4.6× A.
- **k=50, burst (no stagger):** 172 launch retries (429 "Rate limit
  exceeded"), 5 sessions never launched → 5/50 specs failed. Bursting does
  NOT beat the 3/s floor; it converts ramp into flakes.
- **k=20, staggered:** 9673 ms, 0/50 flakes.
- **k=10, staggered:** 7939 ms, 0/50 flakes.
- **k=10, burst:** wall p50 2835 ms (p95 5319 ms), ramp 734–783 ms, 0 retries,
  0/150 flakes. Beats A on suite wall alone — but only because 10 ≤ the burst
  bucket, so no ramp.

Per-spec in-Worker is 277–433 ms vs A's 80 ms = 3.5–5.4× slower; every step
crosses browser → app Worker → Durable Object. Billed session time:
k=50 ≈ 44 s/suite (~0.9 s/session), k=10 burst 16.1/22.1/18.7 s, k=20 31.5 s.

**Data-isolation under C:** the isolation spec (iso-w writes, iso-r reads 0)
passed in all 11 suites at every k — single shared DO store, no cross-account
leak. So C's isolation risk is equal to A's, not higher.

**Preview deploy (setup cost):** app Worker `wrangler deploy` 13.7 s wall
(upload 6.1 s + triggers 2.6 s), first request 200 at 280 ms (no warm-up
gap). Runner Worker deploy 26.8 s, but that is one-time (playwright bundle),
not per-PR.

**How the measured harness was built (not committed — throwaway):**

```sh
# 1. Fixture app ported to a Worker with a single Durable Object store
#    (in-memory Map breaks POST-then-GET across isolates).

# 2. Runner Worker over the `browser` binding (@cloudflare/playwright@1.3.6):
#    one request = one Browser Run session; session runs its round-robin share
#    of the same 50 specs.ts; driver in-Worker, not Mac-side CDP.

# 3. Mac-side orchestrator fires requests, staggered 334 ms (or burst),
#    /reset before each suite, 15 s gap between suites.
```

**Committed alternative (runs the same suite, different shape):**

```sh
# One session PER spec, connectOverCDP straight to the wss endpoint:
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser-throughput/run-c.ts \
    --target https://<preview-deploy>/ --k 50 --runs 5 \
    --out scripts/bench/browser-throughput/out/config-c
```

This is a valid re-measure path, not a byte-exact replay of the maestro's
harness; expect different numbers (session-per-spec vs round-robin, Mac-side
CDP vs in-Worker).

## Cost model (USD per suite)

Basis from v1 / the gate design doc (memory $0.0000025/GiB-s, CPU
$0.000020/vCPU-s active-only, disk $0.00000007/GB-s; re-check the live page).

- **A — one container, k=4:** suite compute ~4 s of a standard-4 (4 vCPU /
  12 GiB / 20 GB). The browser assertion itself is ~4 s of wall in a leg that
  is otherwise dominated by container start + install, exactly like every
  gate leg. One standard-4 10-min leg ≈ **$0.066**; the browser adds its ~4 s
  suite to that, not a separate billing line. Cost is ~1 container.
- **B — N shards:** N × $0.066, wall barely moves. **$0.528 at N=8 for
  ~3.5 s of wall.** Strictly worse than A on both axes.
- **C — Browser Run fan-out:** $0.09/browser-h beyond 10 h/mo inclusion.
  Concurrency is **$2.00/browser beyond 10**, billed as monthly average of the
  DAILY PEAK. So a k=50 fan-out costs ~$80/mo fixed the moment any day peaks
  at 50 sessions; k≤10 costs $0 concurrency. Browser-h stays inside the 10 h
  inclusion until ~800 k=50 suites/mo. k=50 ≈ $0.0011 browser-h/suite, k=10
  ≈ $0.0005, k=20 ≈ $0.0008. C does NOT remove the app's serving cost (the
  preview deploy Worker + its Durable Object).

## Recommendation (by data)

1. **50-spec-class browser suite: one container, k=4.** Measured 3997 ms p50,
   0 flake, cheapest ($0.066), runs the real `playwright test` runner with no
   fixture override. The CPU knee is k=4 on a 4-vCPU container.
2. **Do not gate-shard a browser suite.** Boot+setup per container (39–99 s)
   swamps the 4 s compute; sharding is for the 674 s bun-test lane, not this.
3. **Browser Run fan-out (C) loses at k=50 and end-to-end.** k=50 is 4.6× A
   on suite wall (18.5 s, the ~17 s acquisition ramp IS the wall); bursting
   past the 10-session bucket flakes (5/50). k=10 burst beats A on suite wall
   alone (2.8 s vs 4.5 s wall+boot) but still loses per-PR end-to-end once
   the 13.7 s preview deploy is added (~16.5 s vs ~4.5 s). **C fits only where
   a deploy already happens — a post-deploy check on a real preview/staging
   URL — with k≤10 sessions, no container.** Keep A as the gate default.

## Open

1. **C's account-wide shared launch budget under real gate concurrency.** The
   10-session burst bucket is per account, shared — two PR suites in the same
   ~3 s window means the second is rate-limited. k=10 burst is reliable solo
   and unproven under concurrent PRs.
2. **Measured CF-container cold start** — B spans 30–90 s because the design
   doc still says "unmeasured." A measured cold-start number would collapse
   that span; the B model takes `BENCH_B_COLD_MS` to re-run with it.

## Reproduction

```sh
# A — in-container, no credential:
bun scripts/bench/browser-throughput/run.ts \
  --k 1,2,4,8 --runs 5 --out scripts/bench/browser-throughput/out/config-a

# B — model:
BENCH_B_COLD_MS=60000 bun scripts/bench/browser-throughput/model-b.ts

# C — committed ALTERNATIVE shape (maestro/operator session, CF credential;
#     not the byte-exact measured harness — see Config C section):
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser-throughput/run-c.ts \
    --target https://<preview-deploy>/ --k 50 --runs 5 \
    --out scripts/bench/browser-throughput/out/config-c
```

Guard mutation check: the suite's assertions (counter, item list, isolation,
multi-page title) were each mutated to a wrong expected value and each mutant
was killed. Raw config A runs: 20 suite runs (5 × 4 k), 1000 spec runs, zero
flakes.