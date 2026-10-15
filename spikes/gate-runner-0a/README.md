# gate-spike-0a: Task 0a harness (THROWAWAY)

Refs #715. Plan: `docs/superpowers/plans/2026-10-15-gate-runner.md`, Task 0a. Spec: `docs/superpowers/specs/2026-10-15-gate-runner-design.md`.

Throwaway. Operator-run. Not apps/fleet's wrangler. Not for merge to main as a live component. Names: Worker `gate-spike-0a`, DO class `GateSpikeDO`, binding `GATE_SPIKE`, container `gate-spike-0a`. Do not reuse any tech-fleet name, binding or bucket.

## Measures

| Field | Meaning |
|---|---|
| `start_ms` | Worker dispatch to DO handler entry (DO activation latency) |
| `restore_ms` | `ctx.container.start({ containerSnapshot })` call to `running === true` |
| `cmd_ms` | `ctx.container.exec(["bun","test","test/bun/base64.test.ts"], { cwd: "/baseline/fleet" })` wall time |
| `exit` | Exit code of that `bun test` (red test = data, not an error) |
| `total_wall_ms` | Worker dispatch to all legs settled |

`/probe` returns raw stdout/stderr/exit for: `unshare -r true`, `nproc`, `free -m`, `df -h`, `docker info`.

`/snapshot` boots one `baseline` DO, runs `bun --version`, calls `snapshotContainer()`, stores the snapshot id in DO storage, destroys the baseline.

## API used (checked against installed typings)

Installed: `wrangler 4.151.0`, `@cloudflare/workers-types 5.20261015.1`.

- `ctx.container.snapshotContainer({ name })` returns `{ id, size, name }`.
- Restore: `ctx.container.start({ containerSnapshot: { id }, enableInternet: false, instance: "standard-2" })`. There is no `restoreContainer()`; spec v3 names one, but the typings do not have it.
- Baseline start: `ctx.container.start({ image: ctx.container.images.baseline, ... })`.
- `ctx.container.exec(cmd, { cwd, signal })`, `.output()`, `.running`, `.destroy()`.
- Wrangler rules for `durable_object` containers: top-level `containers[]` accepts only `name`, `class_name`, `scheduling_policy`, `images`, `observability`, `ssh`, `authorized_keys`. Instance size is set per `start()`. No `max_instances` for this policy.

Doc URLs, cited from spec v3. The docs host was unreachable from the build sandbox, so re-check each before deploy:
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/platform-details/limits/

## Image

`Dockerfile`: `oven/bun:1.3-debian` (digest reused from `apps/fleet/Dockerfile`), plus git, node, util-linux, procps. Baseline = `apps/fleet` at SHA `3e8ef2ad42a3ef4ce39bf57f167d07141195806d` (`ARG FLEET_SHA`), `bun install --frozen-lockfile` done at build. Built by `wrangler deploy` from local Docker, linux/amd64.

Docker was not available in the build sandbox. The `Dockerfile` was not build-tested. The first `wrangler deploy` is the first real build.

## Deploy, run, teardown

Run from `spikes/gate-runner-0a/`. Requires Docker running on the Mac and a Cloudflare account with Containers enabled.

```sh
cd spikes/gate-runner-0a
npm ci
npx wrangler login
npx wrangler deploy                          # builds image, creates GateSpikeDO (durable_object policy)
npx wrangler secret put SPIKE_TOKEN          # paste a random token, e.g. openssl rand -hex 32
export URL="https://gate-spike-0a.<your-subdomain>.workers.dev"
export T="<the SPIKE_TOKEN value>"

curl -sS -X POST -H "x-spike-token: $T" "$URL/snapshot"
curl -sS -H "x-spike-token: $T" "$URL/probe"

curl -sS --max-time 1200 -X POST -H "x-spike-token: $T" "$URL/fanout?n=8"  | tee n8.json
curl -sS --max-time 1200 -X POST -H "x-spike-token: $T" "$URL/fanout?n=24" | tee n24.json
curl -sS --max-time 1200 -X POST -H "x-spike-token: $T" "$URL/fanout?n=48" | tee n48.json

npx wrangler delete gate-spike-0a            # teardown; then check the dashboard for leftover container instances
```

Auth: every route needs `x-spike-token`. Missing or wrong token returns 401. Unset secret returns 500.

Run order matters: `/snapshot` before `/fanout` (fanout returns 409 without a snapshot). Run `/probe` before the fanouts to learn the sandbox limits first.

## Expected cost per run (estimate, not verified)

Rates were not checked live. The pricing page could not be reached from the build sandbox. Confirm current rates before running.

- Assumed `standard-2` (1 vCPU, 6 GiB): about $0.129 per container-hour (vCPU $0.000020/s + 6 GiB × $0.0000025/s).
- Assumed about 4 min per leg (restore + `bun test` + destroy): about $0.009 per leg.
- Full run (N=8, 24, 48, plus baseline and probe): about 80 legs, about $0.70. Paid-plan included allowances may cover most of it.
- Top-of-run check: 48 concurrent legs × 1 vCPU is 48 vCPU, far under the 1,500 vCPU account cap (https://developers.cloudflare.com/containers/platform-details/limits/).

## Results table template

Copy to `docs/superpowers/evidence/2026-10-15-gate-runner-snapshot-spike.md` and fill it in. That file is not created by this harness.

**Snapshot** (from `POST /snapshot`)

| snapshot_id | snapshot_size | boot_ms | snapshot_ms | bun_version | fleet_sha |
|---|---|---|---|---|---|
| | | | | | |

**Fan-out** (from `n*.json`; p50 / max, ms)

| N | run_id | ok (exit 0) | exit≠0 | error | start_ms p50/max | restore_ms p50/max | cmd_ms p50/max | total_wall_ms |
|---|---|---|---|---|---|---|---|---|
| 8 | | | | | | | | |
| 24 | | | | | | | | |
| 48 | | | | | | | | |

Quick check, from the JSON:

```sh
jq '[.instances[].restore_ms] | sort' n48.json
```

**Probe** (from `GET /probe`)

| command | exit | verdict (raw output pasted in appendix) |
|---|---|---|
| `unshare -r true` | | |
| `nproc` | | |
| `free -m` | | |
| `df -h` | | |
| `docker info` | | |
