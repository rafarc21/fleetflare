# Gate browser suite THROUGHPUT benchmark (#1364)

v1 (#1347) measured per-run latency. This measures WHOLE-SUITE wall time:
does concurrency beat per-run slowness? A 50-spec Playwright fixture suite
against a small fixture app, three configs.

## Configs

- **A — one container, Playwright workers k=1,2,4,8.** `run.ts` (orchestrates)
  + `run-one.ts` (one k, one browser, fresh process per k). Runs today,
  no credential.
- **B — N gate-style shards (containers).** `model-b.ts` folds config A's
  measured per-shard time with gate boot/overhead constants. Arithmetic only.
- **C — preview deploy + 50 Browser Run sessions in parallel.**
  `run-c.ts` (connectOverCDP, one session per spec). Needs a CF credential —
  run from the maestro's session, exact steps below.

## Run it

```sh
# A — in-container, no credential (fresh process per k, one browser reused per k):
bun scripts/bench/browser-throughput/run.ts \
  --k 1,2,4,8 --runs 5 --out scripts/bench/browser-throughput/out/config-a

# B — model (reads config A's aggregate.json):
BENCH_B_COLD_MS=60000 bun scripts/bench/browser-throughput/model-b.ts

# C — Browser Run fan-out (maestro session only; studio holds no CF credential):
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser-throughput/run-c.ts \
    --target https://<preview-deploy>/ --k 50 --runs 5 \
    --out scripts/bench/browser-throughput/out/config-c
```

## What it measures

- **suite wall** — wall clock for all 50 specs under k workers, p50/p95 over
  >=5 suite runs.
- **boot** — one browser's launch (A) or the parallel connect of all k
  sessions (C), p50.
- **flake rate** — failed specs / total specs across all runs.
- **data isolation** — spec 49 writes as account `iso-w`, asserts account
  `iso-r` sees nothing. Fixture state is keyed per account (see
  `fixture/app.ts`); `/reset` clears between suite runs.

## Raw output

`out/config-a/{runs.csv,aggregate.json}` (per-k in `k<N>/`),
`out/config-c/{runs.csv,aggregate.json}` (maestro). `aggregate.json` is the
source of truth; re-running overwrites (delete `out/` for a clean set).

## Data-isolation risk

The fixture isolates by account id (`?account=`), in a single in-memory
`Map`. Config A shares one browser but gives each spec its own account id,
so no spec observes another's writes. The one real isolation hazard is the
shared app store: if two specs ever reused an account id they would race.
Specs 1-48 use `a1..a24`; the isolation pair uses `iso-w`/`iso-r` — disjoint
on purpose. Config C is identical per spec (each session hits the same
account ids against the deployed preview), so isolation risk is equal across
configs, not a config-C penalty.