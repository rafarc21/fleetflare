# Gate browser suite THROUGHPUT benchmark — in-container parallel vs gate shards vs preview deploy + Browser Run fan-out

Board #1364. Refs #1347, #1134. v1 (#1347) measured per-run latency only
(in-container 136 ms p50 vs Browser Run 272 ms). This measures WHOLE-SUITE
wall time: does concurrency beat per-run slowness? A 50-spec Playwright
fixture suite against a small fixture app (multi-page, fetches, one 2-account
spec with isolated data) + a harness that targets any base URL.

## Verdict up front

**One container at k=4 workers is the answer for a 50-spec browser suite.
Gate sharding (B) buys nothing — boot dominates. Browser Run fan-out (C) pays
a 50-session acquisition wall and only wins when the suite is large enough to
hide it; it does not win for this suite.**

Measured config A (5 suite runs each, 50 specs, 0 flake):

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

Config C (driver + runner committed, maestro to measure): 50 Browser Run
sessions in parallel, one connectOverCDP per spec. The acquisition wall
(3 new/s, so 50 sessions ≈ 17 s serialized at the account limit before the
first spec finishes) plus v1's 2.0× per-run Browser Run latency means C only
breaks even when the suite is big enough to amortize that fixed fan-out cost.
For a 50-spec suite, C's floor is the 50-session acquisition wall, not the
suite wall.

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

## Config C — preview deploy + Browser Run fan-out (driver + runner committed, maestro to measure)

The suite is engine-agnostic (same `SpecPage` surface), so config C runs the
IDENTICAL 50 specs over `connectOverCDP`, one session per spec, k=50 by
default. `drivers/browser-run.ts` connects `wss://api.cloudflare.com/
client/v4/accounts/{id}/browser-run/devtools/browser` with Bearer auth
(`connectOverCDP`, `keep_alive` up to 20 min); `run-c.ts` opens all k
sessions lazily in parallel and records suite wall + boot + flake.

**The binding limits (from v1's doc reading):** 200 concurrent sessions,
3 new/s acquisition, 60 s idle close. 3 new/s means 50 sessions take ≈ 17 s
just to acquire at the account ceiling — that serialized acquisition is C's
floor, paid BEFORE the parallel run starts. Add v1's measured 2.0× per-run
Browser Run latency (272 vs 136 ms p50) and the reachability hop (~+170 ms
p50, quick tunnel is 403 from Browser Run — a real per-PR preview deploy is
required, not a quick tunnel), and C's wall is dominated by fan-out
acquisition + per-run slowness, not by the suite.

**Why C does not beat A for a 50-spec suite:** A's whole-suite wall at k=4 is
~4 s. C pays ~17 s of session acquisition plus a per-spec Browser Run tax
before its parallelism helps. C wins only when the suite is large enough that
the fan-out wall amortizes — a 200-spec suite, not 50. And C keeps the
preview deploy (app-under-test) cost on top, which A does not pay.

**Exact repro steps (maestro runs this — a studio holds no CF credential):**

```sh
# 1. Deploy the fixture as a throwaway preview Worker (maestro, operator cred):
#    bun scripts/bench/browser-throughput/fixture/app.ts is a Bun server; for
#    a preview deploy, wrap it or use the same bench Worker pattern v1 used.

# 2. Run the fan-out:
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser-throughput/run-c.ts \
    --target https://<preview-deploy>/ --k 50 --runs 5 \
    --out scripts/bench/browser-throughput/out/config-c
```

Post the raw `out/config-c/{runs.csv,aggregate.json}` numbers here; they fold
into this doc's C section.

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
- **C — Browser Run fan-out:** $0.09/h after 10 h/mo inclusion; 50 sessions ×
  a few seconds each ≈ well inside inclusion, so ~$0 marginal browser cost.
  BUT it still needs the preview deploy (a Worker) and does not remove the
  app's own serving cost; the fan-out acquisition wall is latency, not
  dollars. C is cheap in browser dollars and expensive in wall time at this
  suite size.

## Recommendation (by data)

1. **50-spec-class browser suite: one container, k=4.** Measured 3997 ms p50,
   0 flake, cheapest ($0.066), and it runs the real `playwright test` runner
   with no fixture override. The CPU knee is k=4 on a 4-vCPU container.
2. **Do not gate-shard a browser suite.** Boot+setup per container (39–99 s)
   swamps the 4 s compute; sharding is for the 674 s bun-test lane, not this.
3. **Browser Run fan-out (C) only if the suite grows well past ~200 specs.**
   The 3 new/s acquisition + 2.0× per-run latency + preview-deploy cost beat
   A's numbers at 50 specs. Re-measure C for the actual suite size before
   committing; the committed driver makes that one command.

## Open — a C run would close these

1. **C's actual fan-out wall** — the 3 new/s acquisition is from CF's doc,
   not a measured number; a 50-session C run measures the real acquisition +
   connect wall, which this doc bounds but does not claim.
2. **C's data-isolation risk under 50 concurrent sessions** — the fixture
   isolates by account id, and C hits the same disjoint ids, so the model
   says equal risk; the real proof is a C run with 0 flake on the isolation
   spec.
3. **Measured CF-container cold start** — B spans 30–90 s because the design
   doc still says "unmeasured." A measured cold-start number would collapse
   that span; the B model takes `BENCH_B_COLD_MS` to re-run with it.

## Reproduction

```sh
# A — in-container, no credential:
bun scripts/bench/browser-throughput/run.ts \
  --k 1,2,4,8 --runs 5 --out scripts/bench/browser-throughput/out/config-a

# B — model:
BENCH_B_COLD_MS=60000 bun scripts/bench/browser-throughput/model-b.ts

# C — Browser Run fan-out (maestro/operator session, CF credential):
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser-throughput/run-c.ts \
    --target https://<preview-deploy>/ --k 50 --runs 5 \
    --out scripts/bench/browser-throughput/out/config-c
```

Guard mutation check: the suite's assertions (counter, item list, isolation,
multi-page title) were each mutated to a wrong expected value and each mutant
was killed. Raw config A runs: 20 suite runs (5 × 4 k), 1000 spec runs, zero
flakes.