# Gate runner — Workflow + GateRunner container design

Issue: https://github.com/rafarc21/fleetflare/issues/715. Date 2026-10-15.
Status: proposal, pending operator review. No code in this PR. No
wrangler.jsonc edit. Phase 0 of #715's own three-phase rollout (below) —
the operator reviews this spec before any implementation plan is written.

**v2 note**: this revision folds in three real review comments from the
repo owner on #715 — codebase-fit corrections, a real-CI-data shard/wall-
clock model, and Cloudflare-platform corrections (`durable_object`
scheduling policy, `ctx.container`, outbound handlers, container
snapshots). Every citation below was re-checked against this repo's own
files before being relied on; the two places that didn't match what's
actually in the file are called out where they come up (Q1, the CLI
section) rather than quietly carried over.

## Non-goals for this doc

- GateRunner is NOT built: no Workflow code, no DO class, no Dockerfile, no
  wrangler binding ships with this PR.
- No redesign of the maestro's batch-merge/autopilot loop. That loop is
  touched only where #715's own scope requires it: the maestro's gate
  script needs one new thing to read (a commit status) and one new CLI to
  call instead of its current Mac script. Everything else about autopilot
  (batching, intersection handling, train deploy) is out of scope here.
- Model-pool work (issue #765,
  `docs/superpowers/specs/2026-10-13-model-pool-design.md:20`) is explicitly
  unrelated — that spec names this one as its own non-goal in the other
  direction.
- **This spec's own gate-runner change fixes the COMPUTE portion of PR
  wall-clock (p50/p90), not the whole PR→merge clock.** See "p50/p90
  honesty," below, for the real numbers and why the remaining post-green
  gap is explicitly the maestro's own, separate fix.

## Why

Today's gate (operator brief, verbatim): fleetflare's gate is the maestro
Mac script `cloud-gate.sh` → closing-keyword check → mergeable check → leak
scan (`prscan.sh`, GNU `grep -P` per denylist pattern in docker
`localci:u24`) → waits for PR checks `classify`, `english`, `check` →
automerge at the scanned head. Maestro autopilot runs up to 3 gates in
parallel. Median PR→merge 17 min (10-12..10-15), p90 66-71 min. `check` job
~10-15 min.

The underlying per-PR suite is run serially today:
`apps/fleet/scripts/localci/localci.sh:164-207` runs `english`, `install`,
`check`, `test-lies-check`, `vitest` and the Linux `bun-test` lane one lane
at a time inside a single gate-lock-held run (`LOCK` at
`localci.sh:237`, `flock`/`lockf` at `localci.sh:407-414`), because the lock
exists to keep at most one heavy job running on the single Mac host at a
time (`localci.sh:20-22`). On the larger of #715's two phase-2 repos the
same shape (vitest run twice serially, 1440 files, plus coverage and cold
builds and rust) stretches to 1.5-3h/PR — the background the issue body
gives for why this is being redesigned at all. **Redaction note, this
revision**: #715's own body names both phase-2 repos; this doc does not
reproduce either name anywhere below (nor above). Pushing an earlier draft
of this revision was refused by this repo's own leak gate
(`/usr/local/bin/git`'s `fleet-leak-scan` against a private denylist at
`/opt/fleet/denylist`) because both phase-2 repo names are denylisted from
`rafarc21/fleetflare`'s public history — confirmed empirically during this
revision, not assumed. Every mention below says "the larger phase-2 repo"
(the 1,440-vitest-file one) or "the other phase-2 repo" instead. The
operator has near-unlimited CF credits; the fix is
to stop sharing one host and instead shard every PR's full suite across
CF containers in parallel, dropping both the per-PR wall time and the
post-merge risk window (today's backstop: a full run after merge, not
before).

## Shape

Two new primitives, neither of which exists in this codebase today:

- **Workflow `gate`.** `grep -r "Workflow|WorkflowEntrypoint|workflows\[" apps/fleet`
  returns nothing — there is no Cloudflare Workflow anywhere in this Worker.
  This spec introduces the first one. Input: repo + PR number. Steps:
  resolve PR head + `main` → merge-tree commit (parent = `main`) → fan out
  one short, idempotent "start shard i" step per leg/shard → event fan-in
  (`waitForEvent`/`sendEvent`, not default step retries — see "Workflow
  fan-in model," below, for why this distinction is load-bearing) → collect
  verdicts → post one commit status → write the run's result to R2.
- **Container class `GateRunnerDO`.** A new Durable-Object-backed class —
  but NOT a fifth instance of the four-part pattern every existing class
  uses today (`durable_objects.bindings` entry + `migrations` tag +
  `containers[]` entry + a class that `extends Container`/`extends
  Sandbox`): `AgentDO` (`extends Container`, `apps/fleet/src/agents/do.ts:178`),
  `DeployDO`, `StudioDO` and `StudioBigDO` (`extends Sandbox`,
  `apps/fleet/src/studio/do.ts:5748`) all sit on Cloudflare's `default`
  container scheduling policy — set once in wrangler config, not chosen per
  instance. `GateRunnerDO` should instead choose the newer `durable_object`
  scheduling policy AT CREATION — a choice that cannot change afterward
  (https://developers.cloudflare.com/workers/wrangler/configuration/#containers) —
  because `durable_object`, not `default`, is what unlocks native
  `ctx.container.exec()` (run a leg's process inside an already-running
  container, no HTTP server to carry a leg's result over), container
  snapshots (beta, below), and picking image/outbound-internet per DO
  instance instead of once in static config. There is no reason to pick
  `default` here — it trades those three things away for nothing
  GateRunner needs. `extends Container`/`extends Sandbox` also only get
  platform updates through 2026-12-31
  (https://blog.cloudflare.com/faster-agent-sandboxes/), one more reason not
  to build a brand-new class on that base today. `GateRunnerDO` runs ONE leg
  or ONE shard per container instance, writes its result, exits. It is not a
  studio: no Claude session, no `claude` binary, no write-proxy.

Legs, run in parallel, one `GateRunnerDO` instance each, named per repo in
that repo's own gate config (fleet.json gate block, below — read from
AGENT_REPO, not the target repo; see Q1/config section for why that
distinction matters). For fleetflare specifically, today's serial lanes
(`apps/fleet/scripts/localci/localci.sh:164-166` `english`; `install`;
`check` — `apps/fleet/package.json:18`'s `bun run check`, five `tsc
--noEmit` invocations across the root/`container`/`cli`/`test-integration`/
`test` tsconfigs, already the whole typecheck job, not a leg this spec adds
on top of it; `test-lies-check` — `package.json:21`; `vitest` —
`package.json:14`; and the Linux `bun-test` lane — `package.json:15`) map
onto: `english` (1 container), `check` (1 container), `test-lies-check` (1
container), `vitest --shard=i/N` for `i` in `1..N`, and `bun-test` split
into shards. There is no `lint` script anywhere in
`apps/fleet/package.json` and no Rust anywhere in this repo (no
`Cargo.toml` in this tree) — a `rust`/`cargo-nextest` leg is per-repo,
present only where THAT repo's own gate config names a Rust command; this
doc does not assert either phase-2 repo has or lacks one, that's each
repo's own config to carry. **`classify` (the one-way-door label,
`.github/workflows/one-way-door.yml`) is NOT a GateRunner leg and this spec
does not touch it**: it keeps running exactly where it runs today, a
required GitHub Actions check posted alongside `gate/verdict` (Q1, below),
never folded into it or dropped from the maestro's required-check set —
dropping it would be a real regression, since it's the one-way-door signal
for the rescue/provision/do/write-proxy/container/deploy paths
(`apps/fleet/scripts/merge-danger.ts:34-105`).

Fleetflare's own shard count N is a measured value, not a number this doc
invents — see "Measured fleetflare shard plan," below, and Testing item 1.

## CF-maximal fan-out (revision, operator directive 08:25Z)

The operator's 08:25Z comment on #715 (posted after this spec's first
commit): use CF resources — containers and browser automation — "as much
as possible... almost unlimited credits and concurrency," five numbered
design points. Restated here in this repo's own terms, each bounded by a
real account limit and its doc link, not a guess:

1. **Wall-clock first, compute cost secondary.** Question 6's cost math
   (below) stays a sanity check against runaway spend, not a ceiling this
   design optimizes toward — every choice below picks "faster, more
   containers/sessions" over "fewer, slower, cheaper" wherever the two
   trade off, matching the operator's own framing ("credits cover it").
2. **Max fan-out, shard to the finest grain worth its cold start, size N
   from the slowest shard, from MEASURED data, not a round number.** See
   "Measured fleetflare shard plan," immediately below — fleetflare's own
   N is now a specific, small recommendation grounded in 98 real green
   `check`-job runs, not the larger phase-2 repo's "N=20-30" (that number
   belongs to that repo's own 1,440-file vitest suite, an order of
   magnitude more files than fleetflare's 208 vitest + 164 bun-test files,
   and gets re-measured independently for phase 2 rather than reused here).
3. **Browser lanes: in-container Chromium stays primary for the real e2e
   leg; Browser Run is a smoke-only addition, not a replacement.** New
   subsection below — this reverses the stance taken earlier in this same
   revision, on CF's own current docs.
4. **Kill setup time: baked image layers, R2 cache, a measured cold-start
   number before trusting any keep-warm plan.** New subsection below
   ("Baseline: container snapshots, not just R2 tarballs" and "Setup time
   and the inactivity trap"); the R2 dependency cache already exists in
   this doc (question 4's `gate/` prefix, baselines keyed by
   `<main-sha>-<lockfile-hash>`), cross referenced here, not reinvented;
   prebuilt image layers is a line added to question 3's Dockerfile
   discussion (below), also not a new mechanism.
5. **Name every binding's real limit + the exact raise ask, never file
   one.** New subsection, "Named limits and raise requests for the
   operator," below.

#### Measured fleetflare shard plan (real CI data, not a model)

Today's `check` job is one serial GitHub Actions job
(`.github/workflows/fleet-check.yml:29-84`: install → typecheck → vitest →
test-lies-check → tmux/chromium/unshare setup → bun-test, all one runner).
98 green runs (run ids 38458176788 → 38704981186, this repo's own Actions
history): wall p50 984s (16.4 min), p90 1014s, queue 2-7s. That p50 is the
number "gate runner" is meant to cut — see "p50/p90 honesty," below, for
why it is not the whole PR→merge clock.

Per-lane p50, same 98 runs: `bun-test` (`package.json:15`, 164 files / 2687
tests, one serial process) 674.5s; `vitest` (`package.json:14`, 208 files /
6726 tests, ~2.4 effective workers) 255s; typecheck (`check`'s 5× `tsc`)
24s; setup (chromium install 21s, `bun install` 3.75s uncached) ~25s.

Hot files inside `bun-test`: `deploy-rescue-gate.test.ts` alone runs 158-
210s across 138 tests, `memguard-docker` 92-95s (1 test),
`bringup-claude-relaunch` 77s, `rescue-push` 73-76s — the top 5 files are
66-69% of the whole lane's wall time. Inside `vitest`, the slowest file is
`studio.burn.test.ts` at 44-60s; everything else is ≤3.1s, and per-file
fixed setup (2.0-2.7s) is 81-83% of vitest's own wall time — meaning
`vitest`'s pain is mostly fixed per-file overhead, not any one slow test.

Shard-count model (slowest shard, seconds, from packing real per-file/per-
test times, not file count):

| N | bun packed by duration | bun by file count (p90) | vitest `--shard` |
|---|---|---|---|
| 1 | 655-693 | same | 208-261 |
| 4 | 209 | 416 | 92 |
| 8 | 209 | 341 | 67 |
| 24 | 209 | 286 | 67 |

Floors: bun bottoms out at 209s once N≥4, pinned there by
`deploy-rescue-gate.test.ts` alone; vitest bottoms out at 67s once N≥8,
pinned by `studio.burn.test.ts`. More shards past those floors buys
nothing — adding containers only helps once the floor itself drops.
`vitest --shard` is hash-sorted equal-COUNT slices, not duration-balanced;
packing by last-run per-file time (not `--shard`'s own default splitting)
is what gets vitest to its 67s floor at N=8 rather than needing far more
shards to land there by luck.

Two concrete floor-dropping moves, in order of payoff:

1. Split `deploy-rescue-gate.test.ts` by individual test name (138 tests)
   across 8+ containers instead of running it as one file — bun's own
   floor then drops to `memguard-docker`'s 95s.
2. Pack bun's remaining files by measured per-file time (not the default
   file-count split) — N=8 packed is 209s vs. 341s unpacked at the same N.

Both moves belong to the baked-image work (point 4, bullet above): bake
bun, tmux, chromium, and a lockfile-keyed `node_modules` into the image so
setup time (currently ~25s/run) stops recurring per shard.

Wall-time model with both moves applied: workflow start + cold start +
checkout (2-8s) + install (4s, cache hit) + ~197-209s compute + fan-in.
Cold start is the one real unknown (≤60s assumed, unmeasured on CF
containers specifically) — see "Setup time and the inactivity trap,"
below. At a ≤60s cold start this lands around 4-5 min wall, meeting a
p50 ≤10 min / p90 ≤15 min target. Coverage: none configured in this repo
today (`package.json`'s `"test"` script is a bare `vitest run`, no
`--coverage` flag) — merge cost is $0 here; the coverage-blob-merge-vs-
128-MiB-isolate question (Q4, below) is a phase-2 concern for whichever of
those repos actually turns coverage on, not fleetflare's own problem today.

**Unknowns this doc does not resolve, named for the first spike instead of
guessed**: cold start on a `durable_object`-policy `GateRunnerDO`; whether
`unshare -r --mount --pid --fork` works inside a CF container at all (the
`deploy-rescue-gate`/`install-cache-security-disk` suites gate on this —
`test/bun/install-cache-security-disk.test.ts:712-730` throws loudly under
`CI=true` if it's missing, rather than silently skipping); whether
Docker-in-Docker works for `memguard-docker.test.ts` (Cloudflare's own
containers FAQ describes `docker:dind` needing root and no `iptables`
support — if that doesn't work inside a `GateRunnerDO` container, that one
file's own suite stays on a GitHub Actions runner as a named fallback,
not silently dropped); and whether `deploy-rescue-gate`'s own per-test
speed (1.15-1.52s/test measured on a GitHub Actions runner today) holds
inside a CF container or runs 3.5-5.5s/test instead (8-13 min for that one
leg if container I/O is that much slower) — all four go in the first
spike (Testing item 1, below), before any N in this doc is final.

**Recommended starting N for fleetflare, pending that spike**: `bun-test`
5 shards (8 once the `deploy-rescue-gate` split lands), `vitest` 8 shards,
`check` 1, `english` 1, `test-lies-check` 1 — **roughly 15-18 GateRunner
containers per PR**, not the 28 a mid-range reading of the larger phase-2
repo's own "N=20-30" produced in this spec's first draft. Every number
downstream of "containers per PR" in this doc (Q5's vCPU math, Q6's cost
math) uses 15-18, not 28, below.

#### p50/p90 honesty: this spec fixes compute, not the whole PR→merge clock

216 PRs merged since 10-12 (this repo's own history): PR→merge wall time
p50 16.7 min, p90 72.8 min. Of that, time spent OUTSIDE CI (after every
required check already went green, waiting on the maestro's own batch/hold
logic) is p50 0.4 min, p90 38.8 min — 16 of 174 PRs sat more than 10
minutes after going green before merging, worst case 966 minutes (PR
#877). Modelling this spec's own ~5-min gate wall time against that same
216-PR history (replacing today's `check`-job wait with a 5-minute
GateRunner wait, holding everything else constant): p50 5.4 min, p90 44.9
min.

**This spec's own change fixes the COMPUTE portion of p50/p90** — it
replaces a 16.4-minute serial `check` job with a parallel run modelled at
4-5 minutes. **It does not touch, and does not claim to fix, the
remaining p90 gap**: that gap is post-green hold time inside the
maestro's own batch-merge/autopilot loop (explicitly out of scope per this
doc's own Non-goals, above) — a separate fix, on the maestro's own side,
not this spec's job.

#### Baseline: container snapshots, not just R2 tarballs

Cloudflare container snapshots (beta,
https://developers.cloudflare.com/containers/guides/snapshots/):
`snapshotContainer()` captures a running container's full filesystem state
and `restoreContainer()` can restore it into ANY DO of the same class, not
just the one that took it — max 20 GB, 30-day TTL, tied to a specific image
version. That is a materially better baseline primitive than this doc's
original "R2 tarball per `<main-sha>-<lockfile-hash>`, container downloads
and untars it" plan: a snapshot restore skips the download-and-untar step
entirely, restoring `node_modules`/build caches/toolchain state directly
into a fresh container's filesystem.

Restore speed, 1→N parallel-restore behavior, and price are all unmeasured
for this account — named here as exactly what the first spike (Testing
item 1) measures, not assumed. **Until measured**: keep the R2 tarball
approach (Q4, below) as the working baseline mechanism, with
snapshot-per-`(main SHA, lockfile hash)` as the upgrade path once restore
time is known to actually beat tarball download+untar at this account's
measured network/disk speed. A baseline is built once per main-branch
merge either way (whichever mechanism wins); a shard's own container
restores from it, fetches the merge-tree commit, and runs.

#### Setup time and the inactivity trap

`max_instances` on a `containers[]` entry (the OLD, `default`-policy shape;
`durable_object`-policy containers have no such field, see Q3/Q5 below) is
a per-class ceiling on how many instances CAN run at once — never a pool of
N pre-warmed, idle instances. Cloudflare containers scale from zero per
request by default, and no `min_instances`/pre-warm field exists on either
scheduling policy (confirmed again this revision, not just carried over) —
"kill setup time" (operator point 4) still needs a mechanism this doc
proposes, not one CF ships natively.

Separately, and more concretely load-bearing for correctness, not just
speed: in-container test work does not, by itself, count as "Workflow
activity" from the DO's own point of view. Without an explicit
`setInactivityTimeout` (max 6h,
https://developers.cloudflare.com/sandbox/concepts/lifetime/) set LONGER
than the longest leg's expected runtime, a `GateRunnerDO`'s own container
can be stopped mid-test the moment its DO looks idle to the platform —
silently truncating a leg that was still genuinely running, not failing it
cleanly. Every `GateRunnerDO` instance must set this explicitly; it is a
correctness fix, not a performance one.

For cold-start latency specifically (the actual "kill setup time" ask): a
scheduled Worker cron (or a Workflow step run on a fixed cadence
independent of any PR) proactively invoking a small resident set of
`GateRunnerDO` instances on a keep-alive cadence shorter than their own
idle-eviction window is still the only mechanism this doc can name — CF
ships nothing native for it. Cost of that tradeoff, computed off the same
pricing figures this doc already cites (memory $0.0000025/GiB-s, disk
$0.00000007/GB-s, CPU $0.000020/vCPU-s ACTIVE ONLY — so an idle-but-warm
container pays memory+disk, not CPU): one standard-4 instance (12 GiB, 20
GB disk) held warm for one hour = `12 × 3600 × 2.5e-6 = $0.108` memory +
`20 × 3600 × 7e-8 = $0.00504` disk ≈ **$0.113/standard-4-instance-hour**,
replacing this revision's earlier, uncomputed warm-pool cost line with an
actual number derived the same way every other cost line in this doc is.
The SIZE of that keep-warm set is still a cost/latency tradeoff Decisions
item 6 (below) asks the operator to pick, now with a real per-instance-hour
number to size it against.

#### Browser lanes: in-container Chromium primary, Browser Run smoke-only

Today's only browser-automation path in this codebase is in-container: the
Linux lane image `apps/fleet/scripts/localci/Dockerfile` bakes in
Playwright + chromium (`bun x playwright@1.63.0 install chromium
--with-deps`, pinned to `apps/fleet/bun.lock`'s `playwright-core`), and
`bun run bun-test` drives it through the `ego-browser` shim
(`skills/ego-browser/SKILL.md`) — already proven, today, by the same
`bun-test` lane this whole spec is sharding.

**This revision reverses this same doc's own earlier stance** ("Browser
Rendering as primary, in-container chromium as fallback"): in-container
Chromium stays PRIMARY for the real e2e leg. Cloudflare's product was
renamed Browser Run (from Browser Rendering —
https://developers.cloudflare.com/browser-run/playwright/, updated here
and everywhere else this doc uses the name); per that same page, the
Workers Playwright fork supports assertions, but Playwright's own Test
runner is, in CF's own words, "not yet fully supported." `connectOverCDP`
from any Node environment does work against it; whether a full `playwright
test` run over CDP actually works end to end is unknown and named as a
spike task, not assumed either way.

Use: in-container Chromium for the real e2e leg (no change — it already
works, already runs inside the sharded `bun-test` containers above); Browser
Run for smoke-testing public URLs only (a much smaller, much less
latency-sensitive use than running the full e2e suite through it), plus a
spike task to find out whether `playwright test` over CDP is viable before
ever treating Browser Run as more than a smoke check. Limit, unchanged from
the earlier revision's own research: 200 concurrent browser
sessions/account, 3 new instances/sec, 60s default session timeout
extendable to 20 min via `keep_alive`
(https://developers.cloudflare.com/browser-run/platform/limits/) — at
smoke-only usage this ceiling is nowhere close to binding; it would only
become a live question if some later feature decided to run full e2e suites
through Browser Run instead of in-container Chromium, which this revision
explicitly does not recommend.

#### Named limits and raise requests for the operator

Every limit above that could realistically bind at fleetflare's or either
phase-2 repo's fan-out scale, with its doc link and what to ask Cloudflare
for if it binds. Naming the ask, not filing it — filing any raise request
stays the operator's call, same posture as every other open decision in
this doc.

- **Containers, account-wide concurrent vCPU/memory/disk**
  (https://developers.cloudflare.com/containers/platform-details/limits/):
  1,500 vCPU / 6 TiB memory / 30 TB disk, shared across EVERY container
  class in the account. `standard-1` is **0.5 vCPU, not 1** — this
  revision's own earlier draft (and #715's own research note) both got
  this wrong; see Q5, below, for the corrected arithmetic this feeds. At
  15-18 containers/PR (not 28) and `durable_object`-policy containers
  (which carry their own admission semaphore rather than a static
  `max_instances`, below), no raise ask is named here; re-check once
  fleetflare's real measured N is final and phase 2 is live with real
  concurrent-PR counts across three repos.
- **Browser Run, 200 concurrent sessions/account**
  (https://developers.cloudflare.com/browser-run/platform/limits/): now
  smoke-only usage per the reversed stance above, so binding is far less
  likely than this doc's earlier draft worried about; still named here in
  case a later feature adds other Browser Run usage on the same
  account-wide ceiling.
- **R2 REST API, 1,200 requests/5 minutes account-wide**
  (https://developers.cloudflare.com/r2/platform/limits/): a REAL
  constraint on fan-out, not theoretical. The presign pattern
  (`install-cache.ts`'s `AwsClient`/SigV4) mints a presigned URL through a
  REST-API-shaped call; at 15-18 shards needing a restore+save presign
  call each, times several concurrent PRs: illustratively, 17 shards × 3
  concurrent PRs × 2 calls/shard = 102 calls per cache-refresh wave (down
  from this doc's earlier 144, purely from the 28→15-18 container-count
  fix) — not binding today, scales linearly with both shard count and
  concurrent-PR count. Mitigation named, not a raise request: batch cache
  restore/save into fewer R2 calls per container (one presigned URL
  covering a multi-file transfer or one manifest fetch, not one call per
  file per shard). Container snapshots (above), once measured, may remove
  this concern for the baseline entirely, since a restore wouldn't go
  through the R2 REST API presign path at all.
- **R2, concurrent writes to the same object key, 1/sec**
  (https://developers.cloudflare.com/r2/platform/limits/): mitigated by
  design already — the baseline key is `<main-sha>-<lockfile-hash>`, so
  two concurrent PRs built against the same main SHA share one baseline
  key; only the first to finish writes, the rest read. No raise ask named.
- **Workflows, concurrent instances/account: 100 (Free) / 50,000 (Paid)**
  (https://developers.cloudflare.com/workflows/reference/limits/): fleet
  runs Paid; not binding at today's 3-concurrent-PR autopilot cap or any
  near-term multiple of it. No raise ask named.
- **Workflows, step cost**: Workers Paid includes 500,000 steps/month, then
  $0.80/100k after
  (https://developers.cloudflare.com/workflows/reference/pricing/). At
  roughly 60 steps/run (per-leg start + fan-in + verdict-post, modelled,
  not yet exact) × an illustrative 900 PRs/month across all three repos
  named in #715 ≈ 54,000 steps/month — well under the included 500,000, so
  **$0 extra** at this volume. See Q6 for the full cost line this folds
  into.
- `max_instances` is NOT a binding limit for `GateRunnerDO` under the
  `durable_object` scheduling policy at all — that policy has no such field
  (Q3/Q5, below); going over it under the OLD `default` policy (as every
  OTHER class in this account still uses) returns an error, not a queue,
  which is exactly why `GateRunnerDO` needs its OWN admission semaphore
  (the Workflow itself tracking how many of its own shards are in flight)
  rather than relying on a config cap the way `AgentDO`/`StudioDO` do.

## Workflow fan-in model: event-driven, not default step retries

Cloudflare Workflows' DEFAULT step behavior is 5 retries, 10-min
timeout/attempt, backoff starting at 10s
(https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
That default is exactly wrong for "did this leg's tests pass": if a step
that runs a leg to completion simply THROWS on a red test (the naive
shape), Workflows retries it up to 5 times, treating a genuinely failing
test exactly like a flaky infra blip — a red test could take up to roughly
an hour to finally surface as `failure`, and would surface looking like 5
separate "the test ran and failed" events the maestro's own flake-rerun
logic was never meant to interpret.

The fix, not merely a style preference: **a red test result is DATA
returned by the shard, never a thrown step exception.** Concretely:

- Each leg/shard's own "start" step is short and idempotent — it starts
  (or confirms already-started) that shard's `GateRunnerDO` container and
  returns immediately. Only an INFRA failure here (the container failed to
  start, an R2 write failed) throws, and default step retry is the right
  tool for exactly that class of failure.
- The container itself runs the leg to completion, then calls back into
  the Workflow via `sendEvent` (through the outbound-handler mechanism, Q4
  below — the container never holds the raw credential this needs) with a
  result payload that NAMES its own outcome: `{status: "success"}`,
  `{status: "failure", ...}` (a real test failed — this is the normal,
  successful completion of that shard's own job, not an error), or
  `{status: "error", ...}` (the shard died before it could report:
  timeout, OOM, crash).
- The fan-in step is `Promise.all` over `waitForEvent` calls, one per
  shard, each with an explicit per-shard timeout.
  `waitForEvent`/`sendEvent` buffers early events
  (https://developers.cloudflare.com/workflows/build/events-and-parameters/),
  so a shard that finishes and calls back before the Workflow's fan-in
  step is even listening does not lose its result.
- `setInactivityTimeout` (above) is set longer than the longest leg's
  expected runtime, so the container itself doesn't get stopped out from
  under a still-running leg while the Workflow is waiting on its event.

This also sidesteps, by construction, v1's open question about whether a
step that `fetch`es a container and polls/awaits its completion counts as
I/O wait or CPU compute against Workflows' per-step compute-time limit
(30s default / 5 min max on Paid): this design never polls from inside a
step at all. `waitForEvent` is itself the native CF primitive for exactly
this "wait for an external signal, don't burn step CPU time doing it"
shape — the only step-compute-time question that remains is whether the
short "start shard i" step (one fetch/RPC to kick off a container, then
return) stays comfortably under 30s, which it trivially does.

## The seven questions

### 1. Verdict: where it posts, how the maestro gate consumes it

No existing helper posts a commit status from Worker code today —
`apps/fleet/src/github/api.ts` has none, `apps/fleet/src/github/auth.ts`
posts nothing. GateRunner is Worker-side (the Workflow's final step, after
event fan-in above), with no `gh` CLI available — it does a plain `fetch`
to `POST https://api.github.com/repos/{owner}/{repo}/statuses/{sha}` using
`workerWriteToken(env, repo, permissions)`
(`apps/fleet/src/write-proxy/gh-route.ts:164-168`) — the Worker's own
real, exported write-credential helper (not `repoToken`, the PAT-only path
at `apps/fleet/src/github/auth.ts:173-177`, which only answers the
question for a PAT-authed owner and says nothing about an App-authed
one): `workerWriteToken` already branches on `resolveRepoAuthKind` and
calls `mintRepoToken(env, repo, {permissions})` on the App path, so
`workerWriteToken(env, repo, {permissions: {statuses: "write"}})` is the
one call GateRunner needs regardless of which credential kind the target
repo is on.

**The real blocker, corrected from this spec's first draft**: the
2026-09-25 ci-steward spec in this same repo
(`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:82-85`)
found the GitHub App used for App-authed owners has NO `statuses`
permission at all (measured against a real installation: issues, actions,
contents, metadata, workflows, issue_types, issue_fields, pull_requests,
repository_hooks, organization_projects — no `statuses`), while
fleetflare itself, AS OF THAT SEPTEMBER SPEC, used a PAT
(`GITHUB_TOKEN`, resource owner rafarc21) whose `Commit statuses: write`
scope was separately flagged UNVERIFIED. The review that prompted this v2
states the LIVE, currently-deployed config (not in this public repo — the
real, account-specific `wrangler.jsonc` lives in a private ops repo per
`apps/fleet/test/wrangler.test.jsonc`'s own header, so this claim is not
independently checkable from inside this repository) now routes ALL
owners, including fleetflare's own, through the App. This revision defers
to that newer, operator-supplied information rather than the September
spec's PAT-based description, but flags plainly that it could not
independently confirm it from anything checked into this repo — **the
first GateRunner smoke run must re-probe whichever credential is actually
live** before relying on `gate/verdict` for anything: `gh api -X POST
repos/rafarc21/fleetflare/statuses/<sha> -f state=pending -f
context=gate/probe` (if PAT) or the equivalent App-token call through
`workerWriteToken` itself (if App). Either way, the fix is the SAME one
line: the operator adds "Commit statuses: write" to whichever credential
the probe shows is actually missing it — a Mac `gh` probe tests the wrong
credential if the live path turns out to be the App, so the probe above
runs through the Worker's own `workerWriteToken` path, not a bare `gh api`
call from a Mac.

**Credential isolation from the PR's own process.** The verdict POST
itself already happens Worker-side (the Workflow's final step, after every
shard has reported), never inside a `GateRunnerDO` container — so the
commit-status credential was never reachable from the PR's own running
test code to begin with. The REAL version of this risk is narrower but
still real: each shard's own RESULT (pass/fail JSON, written to R2 so the
fan-in step can read it) is produced by a process running the PR's own,
untrusted test code. If that process also held a raw, reusable credential
(an R2 API secret, a GitHub token) it could use that credential for
anything beyond writing its own one result — not just lying about its own
outcome (a narrower, harder-to-fully-close problem; see Q4's shard-result
discussion), but potentially reaching OTHER keys in the same bucket or
other repos entirely. Cloudflare's outbound handlers
(https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
are the real fix, confirmed by this revision against the live docs: "programmable
egress proxies... have access to all Workers bindings... No token is
exposed to the container. The secret lives in the Worker's environment and
is never passed into the sandbox." Concretely for GateRunner: the
container makes a plain, uncredentialed request to a fixed internal path
(`sendEvent` with its result, a private-repo git fetch); the Worker's
outbound handler is the ONLY thing that ever holds the real credential,
injecting it after the request leaves the container's own process
boundary. The credential is categorically unreachable from inside the
sandbox — not merely hoped to be, by construction. Q4, below, applies this
same mechanism to the R2/git side; this section is the GitHub-statuses
side of the same fix.

One aggregated context, not two: **`gate/verdict`**. One context, not
per-leg, because the Workflow is the thing that already knows every leg's
outcome by the time it posts (fan-in step) — the maestro gate script needs
one pass/fail signal, not N. States: `pending` (Workflow started) →
`success` (every leg green) / `failure` (a leg failed) / `error` (a leg
died — timeout, GateRunnerDO OOM/crash, R2 write failure — distinct from a
real test failure, same distinction `localci.sh`'s own `error` state draws
for a signal death). Description names the first failing/erroring leg.

Maestro consumption: today's gate waits on PR checks `classify`, `english`,
`check` (operator brief, above) and reads status the same way the
ci-steward spec already established —
`gh api repos/<o>/<r>/commits/<sha>/status`
(`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:141`).
When `FLEET_GATE_RUNNER` is on for a repo (flag below), the maestro's gate
script's required-green set becomes **`gate/verdict` AND `classify`** for
that repo — NOT just `gate/verdict` alone (a correction from this spec's
first draft): `classify` is unaffected by this spec, keeps running as its
own GitHub Actions job, and keeps gating the merge exactly as it does
today; `gate/verdict` replaces `english`/`check` specifically, since those
two are the lanes GateRunner actually subsumes. This doc does not touch
the rest of the maestro's autopilot loop (batching, train deploy) — only
the one status name and the one CLI call it waits on.

### 2. Flag name

Convention: a plain `"FLEET_X": "off"` var per feature, default off, turned
on per-deployment — `FLEET_TELEGRAM`, `FLEET_DIRECTUS`, `FLEET_JUNIOR`,
`LEAD_MODEL_POOL` (`apps/fleet/wrangler.example.jsonc:89-136`). New var:
**`FLEET_GATE_RUNNER`**, default `"off"`. Both the Workflow trigger path and
the container class stay inert while it's off — same posture
`INSTALL_CACHE_REPOS` absent gives install-cache.ts
(`apps/fleet/src/studio/install-cache.ts:9-14`): zero new behavior, zero new
execs, zero R2 traffic for a repo not opted in.

Repo-scope restriction, mirroring `INSTALL_CACHE_REPOS`'s comma-separated
`owner/repo` list shape (`install-cache.ts:104-114`), since phase 1 is
fleetflare-only and phase 2 adds #715's other two named repos — redacted
here too (not just their owner slugs): the Why section's redaction note,
above, applies to the repo names themselves, confirmed by this revision's
own leak-gate-refused push attempt, not just to owner slugs being operator
config: **`GATE_RUNNER_REPOS`**,
comma-separated `owner/repo`, case-insensitive match against the studio's
resolved work-repo slug, same precedent as `isInstallCacheRepo`
(`install-cache.ts:116-126`). `FLEET_GATE_RUNNER=off` is the master switch;
`GATE_RUNNER_REPOS` only matters once the master switch is on. **An empty
list is NOT "no repos" — same precedent `juniorEnabled` already sets**
(`apps/fleet/src/junior/gate.ts:28-36`: `list.length === 0` returns `true`,
i.e. "enabled for every repo" when the master switch is on and no
restriction list is configured). Phase 1's actual value is a single-entry
list (`rafarc21/fleetflare`) set explicitly, not relying on that
empty-list-means-all behavior by accident.

### 3. Workflow + GateRunner wrangler bindings

Both are wholly new surface — no existing binding of either kind to pattern
against in this repo. **No `kv_namespaces` entry — this spec drops
`GATE_KV` entirely**, see Q4 below for why (R2's own consistency model
makes a KV pointer-lookup unnecessary). Declared shape (sketch, not
committed — this task is docs-only; the exact wrangler.jsonc syntax for a
`durable_object`-scheduling-policy container is itself unverified by this
revision — no example of that shape exists anywhere in this repo today —
so the block below names the DECISIONS (policy, image, outbound-internet
choice, no `max_instances`) rather than inventing exact key names this
doc can't confirm):

```jsonc
// Workflow — CF Workflows binding shape (new to this Worker; no existing
// workflows[] entry anywhere in apps/fleet).
"workflows": [
  { "name": "gate", "binding": "GATE_WORKFLOW", "class_name": "GateWorkflow" }
],
// GateRunnerDO — deliberately NOT the four-part containers[]/default-policy
// pattern every existing class uses (wrangler.example.jsonc:183-242, see
// AgentDO/DeployDO/StudioDO/StudioBigDO there). This DO class should be
// declared on the `durable_object` scheduling policy instead, chosen once
// at creation and irreversible after
// (https://developers.cloudflare.com/workers/wrangler/configuration/#containers) --
// image and outbound-internet access are named per instance at creation
// time through ctx.container, not pinned once in a static containers[]
// entry, and there is no max_instances field on this policy to configure
// at all (Q5, below, covers what replaces it: GateRunnerDO's own admission
// semaphore). The exact wrangler.jsonc key shape for declaring a DO class
// on this policy is NOT confirmed anywhere in this repo today -- naming
// the decision here, not guessing the syntax.
"durable_objects": {
  "bindings": [
    // ...existing AGENT / DEPLOY / STUDIO / STUDIO_BIG entries (unchanged,
    // all stay on the default policy), plus:
    { "name": "GATE_RUNNER", "class_name": "GateRunnerDO" }
  ]
},
"migrations": [
  // ...existing tags for this account's live classes, plus:
  { "tag": "<next>", "new_sqlite_classes": ["GateRunnerDO"] }
]
```

`GateRunnerDO`'s Dockerfile path is deliberately `./scripts/gate/Dockerfile`
(sibling to `apps/fleet/scripts/localci/Dockerfile`), not under
`apps/fleet/container/` where every other class's Dockerfile lives — see
Rollback, below, for the `ONE_WAY_GLOBS` fix this placement now requires
(fixed in this revision, not just flagged).

Wherever it ends up living, its content should extend
`apps/fleet/scripts/localci/Dockerfile`, not start fresh: that image
already bakes in the slow layers (`apt-get install` of tmux, git, zstd; the
gitleaks download; `playwright@1.63.0 install chromium --with-deps`) at
image-build time, not per-container-start, and already needs `node` on
`PATH` (`localci.sh:382-387`: without it, `bun run test` runs vitest on
Bun, its config fails to load, and 0 tests silently run — the exact
failure mode a CI image swap must not reintroduce). `GateRunnerDO`'s own
image should keep both `bun` and `node`, plus whatever the `rust` leg needs
for any repo whose own gate config names one — and otherwise reuse what's
already pinned and cached rather than re-deriving it. Once this Dockerfile
exists, add `gate` to the recognized image names in
`apps/fleet/scripts/image-repro-check.sh:4`'s own list (today: `agent`,
`deploy`, `studio`) so its reproducibility check covers this image too.
This satisfies operator point 4's "prebuilt image layers" by extension, not
a second mechanism.

### 4. R2 layout (no KV)

R2: the **existing** `STUDIO_ARCHIVE` bucket (binding declared
`wrangler.example.jsonc:176`), not a new bucket — same reasoning
install-cache.ts already gives for reusing it
(`install-cache.ts:30-44`): a new prefix inside one bucket, never a new
bucket, since GateRunner never needs to read or write anything outside what
`STUDIO_ARCHIVE`'s existing R2 API token already scopes.

**Two different categories of bytes, two different transport mechanisms —
this is the fix this revision makes to Q4, not an addendum**:

- **Non-credential-bearing bytes** (baseline tarballs/caches, a shard's
  OWN result JSON): the existing `AwsClient`/SigV4-presigned-URL mechanism
  install-cache.ts already proves (`install-cache.ts:20-28`) stays exactly
  as-is — the Worker mints a presigned URL scoped to one key, the
  container streams the actual transfer straight to/from R2, bytes never
  transit the Worker/DO process. Nothing in these bytes is a secret, so a
  presigned URL reaching the container that produced them carries no
  exposure beyond that shard lying about its own result — a narrower,
  separate problem (mitigated structurally by the fan-in step treating a
  shard's self-reported JSON as data to log and surface, never as the sole
  gate on `success`/`failure` without the shard's own process EXIT CODE
  agreeing with it).
- **Anything credential-bearing** (the verdict's commit-status POST,
  Q1 above; any private-repo git clone/fetch GateRunner needs for a
  phase-2 repo): outbound handlers, never a presigned URL or token handed
  to the container directly. This is the real fix for the risk this doc's
  first draft left open ("a shared bucket's presign reaches any key; a bug
  could overwrite a running studio's own session tarball at
  `sessions/<id>/latest.tar.gz`,
  `apps/fleet/src/studio/archive.ts:247-249"`): the install-cache.ts
  pattern this spec originally borrowed wholesale is fine for a STUDIO's
  own, trusted container running the fleet's own code — it is NOT fine for
  GateRunner, whose container runs arbitrary, untrusted PR code by design.
  The container makes a plain, uncredentialed request; the Worker's
  outbound handler
  (https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
  is the only thing that ever holds the real token, injected after the
  request leaves the container's own process boundary — "no token is
  exposed to the container," per that same page. A compromised or
  malicious PR's own test code literally cannot read or forge the
  verdict/upload credential, because it never has it to read.

New prefix: **`gate/`**, parallel to install-cache.ts's own `caches/`
prefix. Neither is a substring-prefix of the other (`caches/` vs `gate/` —
no collision), same non-collision argument install-cache.ts makes for its
own prefix choice against the archive module's prefix
(`install-cache.ts:30-34`).

Keys under `gate/`:

- `gate/<owner>/<repo>/baselines/<main-sha>-<lockfile-hash>/...` — build
  caches (vite, cargo target where a repo's gate config names a rust leg).
  See "Baseline: container snapshots," above, for the snapshot-based
  upgrade path once measured — this R2 key shape stays the fallback either
  way.
- `gate/<owner>/<repo>/runs/<run-id>/shard-<leg>.json` — one shard/leg's
  own result JSON.
- `gate/<owner>/<repo>/runs/<run-id>/coverage/<leg>.json` — per-shard
  coverage blob, merged by the Workflow's fan-in step, ONLY for a repo
  whose own gate config enables coverage (fleetflare's own `package.json`
  `"test"` script runs no `--coverage` flag today, so this is a phase-2
  concern, not fleetflare's — merging it still needs to respect the same
  128 MiB isolate ceiling install-cache.ts's own header already measures
  against a 0.5-1.1 GiB `node_modules` tarball, `install-cache.ts:16-17`:
  stream/chunk the merge, never buffer every shard's coverage blob in one
  isolate call).

**No KV namespace.** This spec's first draft proposed a `GATE_KV` binding
holding one pointer key (`main-sha:<owner>/<repo>` → baseline prefix) so a
Workflow step could find its baseline without listing R2. That's
unnecessary: R2 is read-after-write STRONGLY consistent
(https://developers.cloudflare.com/r2/reference/consistency/) — KV, by
contrast, is eventually consistent, propagation delay up to 60s in some
regions (https://developers.cloudflare.com/kv/concepts/how-kv-works/),
which would have made `GATE_KV` the LESS reliable of the two for exactly
the lookup it existed to serve. The baseline prefix is already fully
derivable without any lookup at all: `<main-sha>-<lockfile-hash>` — the
Workflow already resolves `main`'s own SHA (Shape, above) and can hash the
lockfile at the merge-tree commit directly. A plain `GET` against that
deterministic R2 key (404 = no baseline yet, build one cold) replaces the
KV pointer entirely, with one fewer binding, one fewer eventual-consistency
edge case, and no `GATE_KV`-is-stale failure mode to design around.

### 5. Instance type, scheduling policy, and admission

standard-4 is 4 vCPU, measured 11.65 GiB usable memory ceiling
(`apps/fleet/container/memguard.ts:5-8`, which also names the real
consequence of exceeding it: no kernel OOM kill at all — the container
thrashes rather than dying cleanly, 211 of 212 DO alarm kills since 09-23
traced to exactly this). `standard-1` is **0.5 vCPU, not 1** — the number
this spec's own first draft, and #715's own research note, both got
wrong; corrected directly against `apps/fleet/scripts/deploy-containers-
changed.ts:73-76`'s own `TYPES` table (`standard-1: [0.5, 4096, 8000]`,
`standard-4: [4, 12288, 20000]`), which this script uses to verify a real
deploy's containers match what was declared.

Recomputed against the PUBLIC template (`wrangler.example.jsonc:196-241`,
the four illustrative classes every stranger's own fleet starts from): 3 ×
`AgentDO` (standard-1) = 1.5 vCPU, 2 × `DeployDO` (standard-1) = 1 vCPU, 5
× `StudioDO` (standard-1) = 2.5 vCPU, 2 × `StudioBigDO` (standard-4) = 8
vCPU — **13 vCPU combined, not 18** (this spec's own first draft's error,
from assuming standard-1 = 1 vCPU).

**The LIVE account's own numbers are different from that public template,
and not independently checkable from inside this repo** — the real,
account-specific `wrangler.jsonc` lives in a private ops repo, confirmed by
`apps/fleet/test/wrangler.test.jsonc`'s own header (every value in THAT
file is explicitly fabricated, "never used for an actual `wrangler
deploy`"). Per the review that prompted this revision: the live config
runs `StudioDO` on `standard-4` with `max_instances` 101 (= 404 vCPU if
fully populated), only THREE DO classes exist live (not four — migrations
tagged v1-v3, not v1-v4), and real headroom against the account's 1,500
vCPU cap is **≈1,004 vCPU**, not the public template's 1500-13=1487 or this
spec's earlier, wrongly-computed 1500-18=1482. This doc relies on that
operator-supplied figure for sizing GateRunner's own ask (below) because it
is specific about a real, configured ceiling (`max_instances`), not a round
estimate; a second, separate estimate from the same round of review
("studios run standard-4 ... 30 studios ≈ 120 vCPU of shared cap") is
ACTUAL usage today, not the configured ceiling — the two don't actually
disagree (404 vCPU is the ceiling if `StudioDO` filled every one of its
101 slots; 120 vCPU is roughly what ~30 real studios draw today, well
under that ceiling), so there's no real tension here once read as "ceiling"
vs. "today's load" rather than two competing answers to the same question.

**`GateRunnerDO` on the `durable_object` scheduling policy has no
`max_instances` field to size at all** — that field, and the "error, not a
queue" behavior when exceeded, belongs to the OLD `default` policy every
other class in this account still uses. Under `durable_object`, admission
is GateRunnerDO's own responsibility: the Workflow (or the DO itself)
tracks how many of ITS OWN shards are in flight and caps that count
itself, rather than relying on a static config number the platform
enforces. **Open question for the operator, replacing v1's "pick a
max_instances number"**: what vCPU/concurrency budget should that
self-imposed admission semaphore target, given ≈1,004 vCPU of real
headroom against the account's 1,500-vCPU cap? At 15-18 containers/PR
(Measured fleetflare shard plan, above) and 3 concurrent PRs (today's
autopilot cap), sizing per-leg rather than uniformly standard-4 (lite for
`english`/`check`/`test-lies-check`, standard-2/3/4 only for the heavier
`vitest`/`bun-test` shards, per Comment 3's own "Top 3 for speed"
framing) draws well under 100 vCPU at once — comfortably inside the
headroom either live-config estimate above supports. This spec does not
pick the exact semaphore number; it names the arithmetic and the
per-leg-sizing idea so the operator (or whoever writes the implementation
plan) can.

### 6. Cost per PR

Same CF pricing-page figures the ci-steward spec already cites (memory
$0.0000025/GiB-s, CPU $0.000020/vCPU-s active only, disk $0.00000007/GB-s —
`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:100`,
dated 2026-09-25; the operator should re-check the current pricing page
before treating this as exact three weeks later).

One standard-4 instance (4 vCPU, 12 GiB), 10 minutes (600s) active, the p50
target from #715: mem `12 × 600 × 2.5e-6 = $0.018`, CPU
`4 × 600 × 2e-5 = $0.048`, disk negligible (well under $0.001 at this size)
— **≈ $0.066/instance-run**, uniform standard-4 sizing for every leg (the
conservative, upper-bound assumption this spec keeps using here; per-leg
right-sizing to `lite` for the small legs, per Q5 above, would lower this
further but is not computed in full here — named as a refinement for
whoever implements this, not invented numbers).

**Per PR, 15-18 containers (Measured fleetflare shard plan, above —
replacing this spec's first-draft 28, which carried over the larger
phase-2 repo's own N=20-30 range unmeasured)**: at 17 (midpoint),
`17 × $0.066 ≈ $1.12/PR` in GateRunner compute. Add Workflow billing: at
roughly 60 steps/run × an illustrative 900 PRs/month across all three
repos named in #715 (fleetflare and its two redacted phase-2 repos) ≈
54,000 steps/month, well under Workers Paid's 500,000 included steps/month
(https://developers.cloudflare.com/workflows/reference/pricing/) — **$0
extra** at this volume, the first time this doc has been able to actually
compute this line rather than flag it as missing. R2 storage/request cost
for baselines + shard JSON stays small relative to the compute line
(baselines deduplicated per main SHA + lockfile hash, not per PR) and is
not broken out separately here.

Monthly run-rate, **illustrative only, PR volume unverified**: the same 900
PRs/month assumption as the Workflow-step line above (30 PRs/day × 30
days, operator to confirm actual volume — no number for this is cited
anywhere in this repo): `900 × $1.12 ≈ $1,008/month` in GateRunner compute
— down from this spec's earlier $1,665/month, purely from the 28→15-18
container-count fix, plus the now-computed $0 Workflow-step line on top.
Against "near-unlimited CF credits" (issue body) this remains the number
to sanity-check that claim against, not a blocker this spec resolves on
its own.

### 7. Rollout and rollback

**Rollout.** Phases, from #715's own body:

1. Workflow + `GateRunnerDO` + R2 cache, fleetflare only, behind
   `FLEET_GATE_RUNNER=off` default and `GATE_RUNNER_REPOS=rafarc21/fleetflare`.
2. Add #715's other two named repos (redacted per the Why section's note,
   above) to `GATE_RUNNER_REPOS` and each repo's OWN gate block — kept in
   the fleet's own config, keyed by repo, never in the target repo itself
   (Config section, below, explains why this matters, not just where it
   lives).
3. Default gate for all maestros (flag flips to `on` fleet-wide once phases
   1-2 hold their p50/p90 target over 10 PRs/repo, per #715's Target
   section — see "p50/p90 honesty," above, for what that target does and
   does not claim to fix).

A container/image change — which `GateRunnerDO`'s own Dockerfile is —
"rolls at image window" per #715's own constraint: the operator sets the
time, peers GO before a deploy that changes any running container's image.
Worker-only changes (the Workflow's own TypeScript, the flag, the R2 key
derivation) need no image window; only the Dockerfile/image change does.
Worker deploy for either half needs the wrangler-auth fix #715 itself names
as a precondition (same blocker the model-pool spec depends on,
`docs/superpowers/specs/2026-10-13-model-pool-design.md:72`).

**Rollback.** Two different reversibility classes, kept separate on
purpose:

- The flag (`FLEET_GATE_RUNNER=off`, or dropping a repo from
  `GATE_RUNNER_REPOS`) is a Worker-only, instantly reversible var flip — no
  image window, no container restart needed beyond the Worker picking up its
  own new `vars`.
- The container image is not instantly reversible once GateRunnerDO
  containers are live and running real PR gates — redeploying an older
  image is itself a new image-window deploy, same as any other container
  class. A flag flip is also not a GUARANTEE of instant effect fleet-wide:
  `deploy.sh`'s own rescue-all gate (`apps/fleet/scripts/deploy.sh:409-463`)
  runs ahead of any deploy that replaces containers, and a DO restart drops
  attached terminals and ABORTS any in-flight exec (`deploy.sh:91-98`) — a
  GateRunnerDO mid-shard at the moment of a deploy loses that shard's own
  run, surfacing as `error`, not `failure`, the same distinction Q1 already
  draws. A Dockerfile-built image also rebuilds on every deploy by default
  unless its digest is pinned
  (`apps/fleet/scripts/image-repro-check.sh:1-11`) — pin GateRunnerDO's
  image digest once it exists, for the same reason every other class's
  image is pinned.
- `apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS`
  (`merge-danger.ts:34-105`) names `apps/fleet/container/**` as one-way
  "container image build; replaces running studio containers on deploy" —
  and `GateRunnerDO`'s own Dockerfile at `apps/fleet/scripts/gate/
  Dockerfile` does NOT match that glob. **Fixed in this revision, not just
  flagged**: `ONE_WAY_GLOBS` needs a new entry,
  `apps/fleet/scripts/gate/**` (parallel to the existing `apps/fleet/
  scripts/deploy*` entry already in that same list), before `GateRunnerDO`
  ships — this is the same real gap #715's own verdict-code coverage
  question raises, and this revision resolves it the same way: add the
  glob, don't move the Dockerfile to live under `container/` instead
  (keeping it under `scripts/gate/` matches this spec's own Q3 framing that
  `GateRunnerDO` is deliberately NOT one of the four `container/`-rooted
  classes).
- The constraint from #715 itself — "must not touch studio container class
  or rescue paths" — is met by construction: `GateRunnerDO` is its own DO
  class, its own container entry, its own Dockerfile, zero shared code path
  with `StudioDO`/`StudioBigDO`'s bringup (`container/studio-bringup.sh`) or
  rescue flow. Nothing in this design edits either.

## Config: `fleet.json` gate block

**Fixed in this revision**: `fleet.json` is read from exactly ONE place —
`AGENT_REPO`, the fleet's own config repo
(`apps/fleet/src/env.ts:216-223`: "the FLEET's own repo... where
`fleet.json` is read from... a work repo must never be able to move that
pointer"; `apps/fleet/src/studio/routes.ts:221`:
`resolveSpawnPolicy(fetchFile, env.AGENT_REPO)`). The TARGET (work) repo
being gated never has its own gate config read at all — not "per-work-repo
commands," this spec's own first-draft phrasing, which would have let a
PR weaken its own gate by editing its own `fleet.json` in its own repo.
The gate block for EVERY repo GateRunner covers lives in the fleet's own
`fleet.json`, keyed by target repo (`owner/repo`), the same shape
`GATE_RUNNER_REPOS`/`INSTALL_CACHE_REPOS` already use for repo-scoped
config elsewhere in this codebase:

```json
{
  "gate": {
    "rafarc21/fleetflare": {
      "install": "bun install --frozen-lockfile",
      "legs": ["english", "check", "test-lies-check"],
      "vitestShards": 8,
      "bunTestShards": 5,
      "pathRules": ["apps/fleet/**", "skills/**", "fleet/blueprint/**", "scripts/**"]
    }
  }
}
```

(Shard counts above are the "Measured fleetflare shard plan" starting
point, above — pending the first spike, not final. A `rust` key is added
only for a repo whose own entry needs one; this doc does not assume either
redacted phase-2 repo does or doesn't.)

`pathRules` mirrors the existing skip-fleet-check path filter
(`localci.sh:378-381`, same four prefixes `.github/workflows/fleet-
check.yml:9-19` already filters on): a PR touching none of these paths
skips the whole gate the same way `localci.sh` sets `IMAGE=none` for a
no-op diff today.

## CLI

**Fixed in this revision**: `fleet gate start <pr>` and `fleet gate watch
<pr>` — space-separated verbs, NOT `gate-start`/`gate-watch`. This spec's
first draft got this backwards by citing the wrong layer of the CLI code:
the internal TypeScript discriminated-union TAG for a parsed command is
dash-joined (`"models-ls"`, `"accounts-hold"` —
`apps/fleet/src/studio/cli-args.ts:264-265`, `:257-258`), but that tag is
an internal implementation detail, never what an operator types. What
actually appears on the command line is always space-separated, with the
sub-action word as the FIRST token after the top-level verb — confirmed
directly against this repo's own parser for the closest precedent,
`fleet accounts hold <slot>` / `fleet accounts clear <slot>`
(`cli-args.ts:1148-1183`: `case "accounts": { const rest = argv.slice(1);
if (rest[0] === "hold") ...`), and `fleet models assign <studio> <model>`
(`cli-args.ts:1202-1213`). `fleet gate start|watch <pr>` follows that exact
same shape: `case "gate": { if (rest[0] === "start") ...; if (rest[0] ===
"watch") ... }`, dispatching internally to whatever dash-tagged `cmd`
values this doc's implementation plan picks (naming them is an
implementation detail, not this doc's job).

`gate start <pr>` creates a `GATE_WORKFLOW` instance for that PR (idempotent
per PR+head-SHA, same one-run-per-tested-tree idea `localci.sh`'s own
run-id already encodes). `gate watch <pr>` polls the Workflow instance /
`gate/verdict` status to a terminal state and exits with a convention that
extends `localci.sh`'s own (`localci.sh:24`: 0 green, 1 red, 2 infra error,
3 a status POST failed twice) with one new code this spec adds: **4 — the
gate is OFF for this repo** (`FLEET_GATE_RUNNER=off`, or the repo isn't in
`GATE_RUNNER_REPOS`), distinct from every other code, so a calling maestro
script can tell "there is no gate here, fall back to the old wait loop"
apart from "the gate ran and something is actually wrong." Maestros' gate
scripts call `fleet gate start`/`fleet gate watch` instead of
`cloud-gate.sh`'s current wait loop, once `FLEET_GATE_RUNNER` is on for the
target repo.

## Testing / validation plan

Before flipping `FLEET_GATE_RUNNER` default to `on` for any repo:

1. **First spike, before any other number in this doc is treated as
   final**: one `GateRunnerDO` on the `durable_object` scheduling policy,
   on fleetflare, with one baseline (R2 tarball first; container snapshot
   as a follow-up once this spike's own restore-time number exists).
   Measure: cold start; whether `unshare -r --mount --pid --fork` works
   inside this container at all (the `deploy-rescue-gate`/`install-cache-
   security-disk` suites hard-depend on it, `test/bun/install-cache-
   security-disk.test.ts:712-730`); whether Docker-in-Docker works for
   `memguard-docker.test.ts` (fallback: keep that one file on a GitHub
   Actions runner if it doesn't); `deploy-rescue-gate`'s own per-test speed
   inside this container vs. the 1.15-1.52s/test measured on GitHub Actions
   today; and shard wall time at N=8/24/48 for both the restore mechanism
   and the shard count, before fixing either a final N or a final
   admission-semaphore budget (Q5).
2. Unit: merge-tree step (port of `localci.sh:350-363`'s
   `git merge-tree --write-tree` / `git commit-tree` two-parent shape to
   TypeScript, confirmed two-parent at `localci.sh:360`) against a fixture
   repo with a known conflicting and non-conflicting pair — exit-1-is-
   conflict, any other non-zero is a git failure reported in git's own
   words (same distinction `localci.sh:350-352` draws).
3. Unit: leg/shard fan-out via the event model above — N shards requested,
   N `start-shard-i` steps fired (each short, idempotent, retried only on
   an INFRA throw), fan-in via `Promise.all(waitForEvent(...))` with an
   explicit per-shard timeout, never a bare step-level retry on a red test.
4. Unit: `gate/verdict` state machine — pending → success only when every
   leg is `success`; any `failure` → `failure`; any `error` (timeout,
   crash, R2 write failure) → `error`, never silently downgraded to
   `failure`.
5. Unit: flake-rerun policy, ported from `localci.sh:198-207`'s own
   "failure ONLY in a known-flaky file reruns that file once, both results
   recorded" shape — a shard's own `failure` in a file on the known-flaky
   list triggers exactly one rerun of that file, not the whole shard; two
   failures (original + rerun) both ride in the shard's result payload,
   never silently collapsed to one.
6. Live, phase 1, fleetflare only: run `fleet gate start` against the same
   PR a Mac `localci.sh --native` run already scored, diff the pass/fail
   set. Any difference is an environment-drift bug (OS, toolchain version),
   filed before trusting GateRunner's verdict over the Mac one — mirrors
   the first-run comparison the ci-steward spec itself prescribes
   (`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:124`).
7. Measure p50/p90 wall time over 10 PRs/repo per #715's own Target
   section, before expanding `GATE_RUNNER_REPOS` to phase 2 — compared
   against the real baseline this revision now cites (today's `check` job
   p50 984s/16.4min; PR→merge p50 16.7min/p90 72.8min), not an assumed one.
8. Re-probe whichever GitHub credential is actually live (Q1, above)
   against a real PR, through the Worker's own `workerWriteToken` path
   (never a bare Mac `gh` call, which would test the wrong credential if
   the live path is the App), before relying on `gate/verdict` for any
   maestro decision.
9. Confirm the "gate off for this repo" exit code (CLI section, above)
   is reachable and distinguishable from every other exit code in a real
   run against a repo with `FLEET_GATE_RUNNER` on but that repo absent
   from `GATE_RUNNER_REPOS`.

## Decisions asked of the operator

1. Approve the shape above (Workflow `gate` + `GateRunnerDO` on the
   `durable_object` scheduling policy, `gate/` R2 prefix, NO new KV
   namespace, `FLEET_GATE_RUNNER` / `GATE_RUNNER_REPOS` flags) or redirect
   any of the seven questions' answers.
2. Size `GateRunnerDO`'s own admission semaphore (Q5, above — there is no
   `max_instances` to set under the `durable_object` policy): a
   vCPU/concurrency budget against ≈1,004 vCPU of real account headroom
   (the live-config figure this revision relies on, Q5) at 15-18
   containers/PR × however many concurrent PRs (today's autopilot cap is
   3) — and whether to size per-leg (lite for the small legs, standard-2/
   3/4 only for the heavy `vitest`/`bun-test` shards) rather than uniform
   standard-4.
3. Confirm or correct the illustrative PR-volume assumption in the cost
   section (900 PRs/month across all three #715 repos) — the monthly
   run-rate number (and the Workflow-step $0 line) are only as good as
   that input.
4. Confirm the first spike's scope (Testing item 1): one `durable_object`-
   policy `GateRunnerDO` on fleetflare, cold start + `unshare -r` + Docker-
   in-Docker (`memguard-docker.test.ts`) + `deploy-rescue-gate` in-
   container speed + shard wall time at N=8/24/48 — before any N or
   semaphore budget in this doc is treated as final.
5. Re-verify whichever GitHub credential (App or PAT) is actually live for
   `Commit statuses: write` (Q1, above) — this revision defers to the
   operator's own claim that the App is now live for all owners, but could
   not independently confirm that from anything in this repo, so the first
   smoke run's probe (Testing item 8) is the actual confirmation, not this
   doc.
6. Size the keep-warm set for `GateRunnerDO` (Setup time subsection,
   above): how many instances stay cron-nudged resident, trading idle
   compute $ (now a real number: ≈$0.113/standard-4-instance-hour) for
   eliminated cold-start latency. This spec names the mechanism and its
   cost, not a size.
7. Confirm fleetflare's own recommended starting shard plan (Measured
   fleetflare shard plan, above: `bun-test` 5 shards, 8 after the
   `deploy-rescue-gate` split; `vitest` 8 shards; `check`/`english`/
   `test-lies-check` 1 each — 15-18 containers/PR, not the issue's own
   N=20-30, which is the larger phase-2 repo's own number for its 1,440-file
   suite, re-measured independently for each phase-2 repo rather than
   reused here) as the starting point pending the first spike's own
   on-container wall-time measurement.
8. Decide whether to pursue container snapshots as the baseline mechanism
   (Baseline subsection, above) once the first spike measures restore
   time, or keep the R2-tarball approach as the standing mechanism rather
   than a fallback.
9. Two named limits that are not yet binding but could become so as fan-
   out grows (Named limits subsection, above) — confirm whether either
   needs a raise request filed once real numbers are measured, or whether
   the named mitigation (R2 call batching per container) is sufficient on
   its own:
   - R2 REST API, 1,200 requests/5 min account-wide.
   - Browser Run, 200 concurrent sessions/account (now smoke-only usage,
     per the reversed stance above — far less likely to bind than this
     doc's earlier draft assumed).
