# Gate browser engine benchmark — CF Browser Run vs in-container Chrome

Board #1347. Pick the gate's browser engine by data, not by assertion.
Refs #1134.

## Verdict up front

**In-container Chrome stays the engine for a real e2e leg. CF Browser Run is
not a drop-in replacement today, and the data that exists says the
decoupling it offers does not pay for itself on the leg wall it adds.**

Two independent reasons, only one of which needed measuring:

1. **CF Browser Run still does not run this repo's e2e suites.** Playwright's
   Test runner is, in CF's own words, "not yet fully supported" (only
   Assertions are) — https://developers.cloudflare.com/browser-run/playwright/.
   A gate e2e leg runs `playwright test`, so Browser Run cannot back it as-is.
   This is a product gap, not a performance number.
2. **Measured (this spike): in-container Chrome is fast and stable, and the
   reachability a remote engine needs adds real latency to the leg wall.**

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

### CF Browser Run (NOT measured live)

The `browser-run` driver is committed and type-correct against
playwright-core 1.63 (`connectOverCDP` with the `headers` option), ready to
run the instant an account id + Bearer token exist. It was not run because a
studio container holds no Cloudflare credential by design (house rule), and
`fleet creds get browser-*` is not allowlisted for this repo. See
"Credential gap," below.

Recon facts carried into the driver (task-provided, CF-doc-confirmed):
endpoint `wss://api.cloudflare.com/client/v4/accounts/{accountId}/browser-run/devtools/browser`,
Bearer auth, `keep_alive` ≤ 1200000 ms, limits 200 concurrent / 3 new/s /
60 s idle close.

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

**CF Browser Run — $0.09/h after a 10 h/mo inclusion.** A browser leg that
holds a session for a 10-min leg pays ≈ **$0.015** in Browser Run time, and
$0 while under the monthly inclusion. But it does not remove the container:
the app-under-test (dev server) and the test orchestration still run in a
container, so the container cost does not go away. Browser Run replaces only
the browser process, at the price of the reachability hop above plus a remote
connect (typically 1–3 s) per leg.

**The decoupling does not obviously pay.** The operator's own note in the
task ("decoupling may lose efficiency; data decides") is what the tunnel
measurement bears out: moving the browser off-container costs ~44 ms p50 per
suite pass in added hop latency and still keeps the container for the app,
while saving only the ~0.5 s browser boot and the chromium memory/CPU inside
that container. For a smoke check on a public URL (no app-in-container to
reach), Browser Run is a real win — zero container, zero tunnel. For a gate
e2e leg against an in-container dev server, it is not.

## Playwright Test runner support (current)

Per https://developers.cloudflare.com/browser-run/playwright/: "The following
capabilities are not yet fully supported, but we're actively working on
them" — first item "Playwright Test except Assertions." `connectOverCDP` from
any Node environment works; a full `playwright test` run over CDP does not.
This alone forecloses Browser Run for this repo's e2e suites today, whatever
the latency numbers say.

## Recommendation

1. **Real e2e leg: in-container Chromium.** Proven (this repo's own
   `bun-test` lane already drives it through `ego-browser`), measured
   (~140 ms p50, 0 flake), and it runs the actual `playwright test` runner.
2. **Smoke check on a public URL: CF Browser Run.** No app-in-container, no
   tunnel, no container vCPU spend — the one shape where decoupling is a
   straight win. Config-gated, not a hard-coded switch, same posture as the
   existing `fleet.json` gate block.
3. **Re-evaluate when Browser Run ships the Test runner.** The blocker is the
   runner gap, not the numbers; if it closes, re-run this harness
   (`bun scripts/bench/browser/run.ts browser-run --runs 12 --target …`) and
   the latency question becomes the deciding one.

## Credential gap — needs operator

The one piece this spike could not measure live is Browser Run's own leg wall
and boot overhead, because no Cloudflare credential exists in this container
and `fleet creds get` does not allowlist a browser token for this repo. To
close it, one of:

- operator allowlists a `fleet cred` (account id + Bearer token) for this
  repo, or
- operator runs the two browser-run commands below from their own session
  (a throwaway Worker on the CF account is fine; delete after).

```sh
CF_BROWSER_ACCOUNT_ID=… CF_BROWSER_TOKEN=… \
  bun scripts/bench/browser/run.ts browser-run --runs 12 --target https://<tunnel-or-preview>/
CF_BROWSER_ACCOUNT_ID=… CF_BROWSER_TOKEN=… \
  bun scripts/bench/browser/cold-boot.ts browser-run
```

## Reproduction

```sh
bun scripts/bench/browser/run.ts chrome --runs 12                 # in-container
bun scripts/bench/browser/run.ts chrome --runs 12 \
  --target https://<tunnel>/ --out chrome-tunnel                  # reachability cost
bun scripts/bench/browser/cold-boot.ts chrome                     # boot overhead
```

Guard mutation check: the suite's 5 assertion guards were each mutated to a
wrong expected value and each mutant was killed (5 guards, 5 mutants,
5 killed). Raw runs: 24 direct + 12 tunnel, zero flakes.