# Gate browser engine benchmark — CF Browser Run vs in-container Chrome

Board #1347. Pick the gate's browser engine by data, not by assertion.
Refs #1134.

## Verdict up front

**In-container Chrome stays the engine for a real e2e leg. Browser Run is
viable, but slower on every axis measured and needs a driver co-located on
Cloudflare plus non-quick-tunnel reachability.**

Measured, same 9-step suite on both:

| axis | in-container Chrome | Browser Run (best set) | ratio |
|---|---|---|---|
| leg wall p50 | 136 ms | 272 ms | 2.0× |
| leg wall p95 | 201 ms | 547 ms | 2.7× |
| cold start p50 | 512 ms | 613 ms | 1.2× |
| bridge reachability p50 | +44 ms | +~170 ms | ~4× |
| flake rate | 0/24 | 0 | tie |

Browser Run is also subject to a batch-level variance anomaly (one 24-run
batch at 1840 ms p50 vs 272 ms elsewhere, unexplained — see below), which
Chrome did not exhibit. The decoupling Browser Run offers does not pay for
itself on the leg wall: the browser process moves off-container, but the
app-under-test and test orchestration stay in a container, and every
assertion still crosses the reachability hop.

## What was measured

A fixed 9-step assertion suite (load, title, click, input fill, input value,
async-wait, count) against a tiny in-container fixture server. Both engines
run the same suite over the same minimal page surface, so the leg wall is the
same work on both. Raw numbers in `scripts/bench/browser/out/`; the harness
and drivers are committed in `scripts/bench/browser/`.

### In-container Chrome (measured, 24 direct runs)

| metric | value |
|---|---|
| leg wall p50 | 136 ms |
| leg wall p95 | 201 ms |
| leg wall min / max | 99 / 208 ms |
| leg wall mean | 141 ms |
| flake rate | 0 / 24 |
| cold boot (fresh process, import + launch) p50 | 512 ms |
| cold boot p95 | ~700 ms |
| cold boot range | 463–723 ms (10 samples) |

Chromium 153.0.8010.12, playwright-core 1.63.0 — the same binary and version
the gate image already bakes (`apps/fleet/scripts/localci/Dockerfile`).

### Reachability cost (measured, 12 tunnel runs)

A remote engine cannot reach a fixture bound to `127.0.0.1` inside the
container. It must reach it through a cloudflared tunnel or a per-PR preview
deploy. To isolate that hop's cost, the SAME in-container Chrome ran the SAME
suite against the SAME fixture through a quick `cloudflared` tunnel:

| metric | direct | through tunnel | delta |
|---|---|---|---|
| leg wall p50 | 136 ms | 180 ms | **+44 ms** |
| leg wall p95 | 201 ms | 209 ms | +8 ms |
| flake rate | 0/24 | 0/12 | — |

The tunnel adds ~44 ms p50 to the leg wall. A remote engine pays this on
EVERY assertion that touches the app, not once — the per-step latency, not the
boot latency, is the tax. Per-PR preview deploy would add deploy wall on top.

### CF Browser Run (measured by maestro, PARTIAL — host reboot cut the run short)

Run by the maestro locally (Mac, wrangler OAuth, throwaway Worker with a
`browser` binding, `@cloudflare/playwright@1.3.6`, browser colo MAD), same
9-step suite. Raw per-run samples were lost to the reboot; only the
aggregates below survived, recorded in
`scripts/bench/browser/out/browser-run/results.json`.

| metric (ms) | n | p50 | p95 | flakes |
|---|---|---|---|---|
| leg, in-Worker driver, Worker-served fixture (interleaved) | 18 | 272 | 547 | 0 |
| leg, in-Worker driver, tunnel bridge (interleaved) | 18 | 446 | 796 | 0 |
| leg, in-Worker driver, Worker fixture (batch 1 — ANOMALY) | 24 | 1840 | 2089 | 0 |
| leg, in-Worker driver, tunnel bridge (batch 1) | 24 | 406 | 761 | 0 |
| cold session start (acquire + connect) | 12 | 613 | 1127 | 0 |
| — acquire / connect | 12 | 493 / 124 | 989 / 325 | |
| cold start, Mac wall incl RTT | 12 | 839 | 2045 | |
| leg, Mac-side stock playwright CDP driver, Worker fixture | 24 | 873 | 1098 | 0 |
| leg, Mac-side CDP driver, tunnel bridge | 12 | 1412 | 2391 | 0 |

**Batch-1 Worker-fixture anomaly:** one batch shows newPage p50 383 ms where
everywhere else it is ~80 ms, and the interleaved rerun lands 213–547 ms.
Not root-caused before the reboot — treated as variance evidence: the same
config spans 6.8× across sessions (1840 vs 272 ms p50). Best-set Browser Run
leg (interleaved, in-Worker) is 272/547; the honest spread is 272–1840 p50.

**Reachability finding (hard blocker for the tunnel option):** Browser Run →
`*.trycloudflare.com` quick tunnel is **403 "Your request was blocked"** at
the CF edge, UA override no help. A Worker `fetch()` to the same tunnel works
(p50 26 ms). Workaround: browser → bench Worker `/t/*` proxy → quick tunnel →
fixture. So a real Browser Run gate leg needs a real per-PR preview deploy
(or a named tunnel), not a quick tunnel.

**RTT / confounders:** Mac→CF TCP p50 22 ms, Mac→Worker HTTP p50 76 ms,
Mac→tunnel p50 49 ms, CF(MAD)→tunnel→Mac p50 26 ms. The Mac-side CDP driver
pays Mac→CF RTT per step; the in-Worker driver does not. A gate container
sits closer to CF than the Mac, so the Mac-side rows are an upper bound, not
the gate's own number.

**Playwright Test runner — corrected finding:** with a `connectOverCDP`
browser-fixture override at worker scope, the stock `@playwright/test` runner
**does work**: 12/12 pass, 1.0–2.4 s per test (one 12.2 s outlier). Native
`use.connectOptions` (playwright server protocol) does **not**: `browserType.connect:
Error: Cannot find object to "undefined": undefined`. So the earlier
"runner not yet fully supported" phrasing means the native connect path, not
`connectOverCDP`.

**Auth:** wrangler OAuth token gets 401 on the Browser Run REST endpoint; a
scoped API token could not be minted (9109), so the binding path (option a)
was used, not the direct wss endpoint.

## Cost model (USD per run)

Figures from the gate-runner spec's own pricing basis (memory
$0.0000025/GiB-s, CPU $0.000020/vCPU-s active-only, disk
$0.00000007/GB-s — `docs/superpowers/specs/2026-10-15-gate-runner-design.md`,
re-check the live pricing page before treating as exact).

**In-container Chrome — a browser leg is one standard-4 container.** The
browser assertion itself is ~140 ms p50 (measured above); the leg wall is
dominated by container start + install + the test run, exactly like every
other gate leg. One standard-4 instance, 10 min active, is ≈ **$0.066/run**
(the spec's own upper-bound figure). The browser adds its ~0.5 s cold boot to
that, not a separate billing line.

**CF Browser Run — $0.09/h after a 10 h/mo inclusion, ~$0.00003–0.00004/leg.**
Maestro's estimate: one leg ≈ 1–1.5 s of browser time (start + leg + close),
so the 10 h/mo inclusion covers ~24k–36k legs free, then ~$0.00004/leg.
Billing granularity not verified. It does not remove the container: the
app-under-test (dev server) and test orchestration still run in a container,
so the container cost does not go away. Browser Run replaces only the browser
process, at the price of the reachability hop plus a remote cold start
(~613 ms p50 in-Worker, ~839 ms Mac-wall).

**The decoupling does not pay.** The operator's note in the task
("decoupling may lose efficiency; data decides") is what the data bears out:
Browser Run's best leg wall is 2.0× Chrome's (272 vs 136 ms p50), its cold
start is 1.2× (613 vs 512 ms), its bridge cost is ~4× (+170 vs +44 ms p50),
and it still keeps the container for the app. Where Browser Run wins outright
is a smoke check on a public URL — no app-in-container, no tunnel, no
container vCPU spend.

## Playwright Test runner support (measured, corrected)

The docs' "Playwright Test except Assertions" limitation is about the native
`use.connectOptions` path, not `connectOverCDP`:

- **`connectOverCDP` browser-fixture override at worker scope: works.** 12/12
  tests pass, 1.0–2.4 s per test (one 12.2 s outlier). A gate e2e leg could
  run this repo's `playwright test` suites over Browser Run today via a
  fixture override — no runner support blocker.
- **Native `use.connectOptions` (playwright server protocol): does not work.**
  `browserType.connect: Error: Cannot find object to "undefined": undefined`.

So the deciding factor is latency, not the runner.

## Recommendation

1. **Real e2e leg: in-container Chromium.** Proven (this repo's own
   `bun-test` lane already drives it through `ego-browser`), measured
   (~140 ms p50, 0 flake, no batch-level variance), and it runs the actual
   `playwright test` runner with no fixture override.
2. **Smoke check on a public URL: CF Browser Run.** No app-in-container, no
   tunnel, no container vCPU spend — the one shape where decoupling is a
   straight win. Config-gated, not a hard-coded switch, same posture as the
   existing `fleet.json` gate block.
3. **Do not treat Browser Run as the e2e path unless a rerun closes the
   gaps.** The partial data is enough to keep Chrome primary; the open
   questions below (batch-1 6.8× variance root cause, and n=24 interleaved
   per config) are what a rerun should answer before any re-evaluation.

## Open — a full rerun would close these

1. **Root-cause the batch-1 6.8× variance** (1840 ms vs 272 ms p50, same
   config). If that is a slow-browser-instance draw, it is a real tail risk
   Chrome does not show.
2. **n=24 interleaved per config, cold n≥24, per-step breakdown** — the
   partial run already meets the task's ≥10 per config (n=18 interleaved,
   n=12 cold), but the reboot truncated the interleaved sets before they
   reached the intended n=24; a rerun should complete those.
3. **Browser Run reachability for a real gate leg** — quick tunnel is 403 from
   Browser Run; the workaround is a bench Worker proxy. A per-PR preview
   deploy (or a named tunnel) needs a live test, not the quick-tunnel proxy.

## Reproduction

```sh
# in-container Chrome
bun scripts/bench/browser/run.ts chrome --runs 12
bun scripts/bench/browser/run.ts chrome --runs 12 \
  --target https://<tunnel>/ --out chrome-tunnel                  # reachability cost
bun scripts/bench/browser/cold-boot.ts chrome                     # boot overhead

# CF Browser Run (operator/maestro session — studio holds no CF credential)
CF_BROWSER_ACCOUNT_ID=… CF_BROWSER_TOKEN=… \
  bun scripts/bench/browser/run.ts browser-run --runs 12 --target https://<tunnel-or-preview>/
CF_BROWSER_ACCOUNT_ID=… CF_BROWSER_TOKEN=… \
  bun scripts/bench/browser/cold-boot.ts browser-run
```

Guard mutation check: the suite's 5 assertion guards were each mutated to a
wrong expected value and each mutant was killed (5 guards, 5 mutants,
5 killed). Raw runs: 24 direct + 12 tunnel, zero flakes.