# Gate browser engine benchmark (#1347)

Pick the gate's browser engine by data: CF Browser Run (remote) vs
in-container Chrome (ego-browser / headless chromium).

## Run it

```sh
# In-container Chrome (runs today — no credential needed):
bun scripts/bench/browser/run.ts chrome --runs 12

# Cold boot wall (fresh process -> usable browser):
bun scripts/bench/browser/cold-boot.ts chrome

# CF Browser Run (needs operator credentials — a studio holds no CF token):
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser/run.ts browser-run --runs 12 --target https://<tunnel-or-preview>/
CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_TOKEN=... \
  bun scripts/bench/browser/cold-boot.ts browser-run
```

## What it measures

- **leg wall** — one pass of `suite.ts` (9 steps: load, title, heading, click,
  count, fill, input value, wait-for-async, item count), engine already up.
  p50/p95 over the runs.
- **boot overhead** — `cold-boot.ts` (fresh process: import + launch/connect)
  and `run.ts`'s per-invocation launch (warm process).
- **flake rate** — failed passes / total passes.
- **reachability cost** — the remote engine cannot reach the fixture bound to
  `127.0.0.1` inside this container. It navigates `--target` (a cloudflared
  tunnel or per-PR preview deploy) instead; that hop's added latency is part
  of the remote leg wall.

## Raw output

`scripts/bench/browser/out/<engine>/runs.csv` (append-only raw rows) and
`aggregate.json` (full-set p50/p95/flake, recomputed over every appended
row — the committed source of truth; `summary.json` is per-batch only).
Re-running accumulates rows; delete `out/` for a clean set.

## Browser Run auth

The remote engine needs `CF_BROWSER_ACCOUNT_ID` + `CF_BROWSER_TOKEN`. Per the
studio house rules no Cloudflare credential exists inside a studio container,
so the operator runs the `browser-run` leg (or allowlists a `fleet cred`). The
driver is wired and type-correct against playwright-core 1.63
(`connectOverCDP`'s `ConnectOverCDPOptions.headers`).

Endpoint (task recon facts, CF docs): `wss://api.cloudflare.com/client/v4/accounts/{accountId}/browser-run/devtools/browser`, Bearer auth, `keep_alive` ≤ 1200000 ms.