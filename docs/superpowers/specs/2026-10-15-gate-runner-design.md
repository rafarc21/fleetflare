# Gate runner — Workflow + GateRunner container design

Issue: https://github.com/rafarc21/fleetflare/issues/715. Date 2026-10-15.
Status: proposal, pending operator review. No code in this PR. No
wrangler.jsonc edit. Phase 0 of #715's own three-phase rollout (below) —
the operator reviews this spec before any implementation plan is written.

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
gives for why this is being redesigned at all. The operator has near-unlimited CF credits; the fix is
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
  one step per leg/shard → collect verdicts → post one commit status →
  write the run's result to R2.
- **Container class `GateRunnerDO`.** A fifth Durable-Object-backed
  container class, following the exact four-part pattern every existing
  class uses (`durable_objects.bindings` entry + `migrations` tag +
  `containers[]` entry + its own Dockerfile) —
  `apps/fleet/wrangler.example.jsonc:183-242` is the full pattern, four
  classes today: `AgentDO` (standard-1, max 3), `DeployDO` (standard-1, max
  2), `StudioDO` (standard-1, max 5), `StudioBigDO` (standard-4, max 2,
  release-studio only). `GateRunnerDO` runs ONE leg or ONE shard per
  container instance, writes its JSON result to R2, exits. It is not a
  studio: no Claude session, no `claude` binary, no write-proxy.

Legs, run in parallel, one `GateRunnerDO` instance each: `typecheck`,
`lint`, `invariants/builds`, `rust` (cargo-nextest), and
`vitest --shard=i/N` for `i` in `1..N` (N = 20-30 per #715's own number,
coverage blobs merged after). For fleetflare specifically today's lanes
(`localci.sh:168-174`, `bun install`, `bun run check`, `test-lies-check`,
`vitest`, Linux `bun run bun-test`) map onto this leg list; the exact
per-repo leg list is config (fleet.json gate block, below), not hard-coded
in GateRunnerDO.

Storage: R2 for bytes (baselines per main SHA + lockfile hash, vite build
cache, cargo target cache, shard outputs), a new KV namespace for the one
small pointer (main SHA → baseline prefix) a Workflow step needs to look up
fast without listing R2.

## The seven questions

### 1. Verdict: where it posts, how the maestro gate consumes it

No existing helper posts a commit status from Worker code today —
`apps/fleet/src/github/api.ts` has none, `apps/fleet/src/github/auth.ts`
posts nothing. The only prior art is
`apps/fleet/scripts/localci/localci.sh:251-265` (`post`/`post_both`),
which shells out to `gh api -X POST repos/$GH_REPO/statuses/$SHA -f
state=... -f context=...`, posting two contexts,
`local-ci/fleet-check` and `local-ci/english`. GateRunner is Worker-side
(the Workflow's final step), with no `gh` CLI available — it does a plain
`fetch` to `POST https://api.github.com/repos/{owner}/{repo}/statuses/{sha}`
using a token minted the way every other server-side caller already does:
`repoToken` (`apps/fleet/src/github/auth.ts:173-177`) or, for the
multi-repo case, `repoTokenMinter` (`auth.ts:460-469`).

One aggregated context, not two: **`gate/verdict`**. One context, not per-leg,
because the Workflow is the thing that already knows every leg's outcome by
the time it posts (fan-in step) — the maestro gate script needs one
pass/fail signal, not N. States: `pending` (Workflow started) →
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
script's required-green set becomes just `gate/verdict` for that repo,
replacing `classify`/`english`/`check`, and keeps reading status the exact
same way. This doc does not touch the rest of the maestro's autopilot loop
(batching, train deploy) — only the one status name and the one CLI call
it waits on.

**Open risk, carried forward, not resolved here**: the sibling ci-steward
spec found the PAT's `Commit statuses: write` scope UNVERIFIED as of
2026-09-25
(`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:82-85`).
Nothing in this repo shows whether that was ever fixed. Treat it as still
open — the first GateRunner smoke run must re-probe it (`gh api -X POST
repos/rafarc21/fleetflare/statuses/<sha> -f state=pending -f
context=gate/probe`) before relying on `gate/verdict` for anything.

### 2. Flag name

Convention: a plain `"FLEET_X": "off"` var per feature, default off, turned
on per-deployment — `FLEET_TELEGRAM`, `FLEET_DIRECTUS`, `FLEET_JUNIOR`,
`LEAD_MODEL_POOL` (`apps/fleet/wrangler.example.jsonc:89-136`). New var:
**`FLEET_GATE_RUNNER`**, default `"off"`. Both the Workflow trigger path and
the container class stay inert while it's off — same posture
`INSTALL_CACHE_REPOS` absent gives install-cache.ts
(`apps/fleet/src/studio/install-cache.ts:9-14`): zero new behavior, zero new
execs, zero R2/KV traffic for a repo not opted in.

Repo-scope restriction, mirroring `INSTALL_CACHE_REPOS`'s comma-separated
`owner/repo` list shape (`install-cache.ts:104-114`), since phase 1 is
fleetflare-only and phase 2 adds #715's other two named repos (not
reproduced here — public repo; owner slugs are operator config either
way): **`GATE_RUNNER_REPOS`**,
comma-separated `owner/repo`, case-insensitive match against the studio's
resolved work-repo slug, same precedent as `isInstallCacheRepo`
(`install-cache.ts:116-126`). `FLEET_GATE_RUNNER=off` is the master switch;
`GATE_RUNNER_REPOS` only matters once the master switch is on, phase 1 value
is a single-entry list (`rafarc21/fleetflare`).

### 3. Workflow + GateRunner wrangler bindings

Both are wholly new surface — no existing binding of either kind to pattern
against in this repo. Declared shape (sketch, not committed — this task is
docs-only):

```jsonc
// Workflow — CF Workflows binding shape (new to this Worker; no existing
// workflows[] entry anywhere in apps/fleet).
"workflows": [
  { "name": "gate", "binding": "GATE_WORKFLOW", "class_name": "GateWorkflow" }
],
// New KV namespace — `grep -rn "kv_namespaces" apps/fleet wrangler.example.jsonc`
// returns nothing today; this is the first one.
"kv_namespaces": [
  { "binding": "GATE_KV", "id": "<YOUR_GATE_KV_NAMESPACE_ID>" }
],
// GateRunnerDO — same four-part container-class pattern every existing
// class uses (wrangler.example.jsonc:183-242).
"durable_objects": {
  "bindings": [
    // ...existing AGENT / DEPLOY / STUDIO / STUDIO_BIG entries, plus:
    { "name": "GATE_RUNNER", "class_name": "GateRunnerDO" }
  ]
},
"migrations": [
  // ...existing v1-v4 tags, plus:
  { "tag": "v5", "new_sqlite_classes": ["GateRunnerDO"] }
],
"containers": [
  // ...existing AgentDO / DeployDO / StudioDO / StudioBigDO entries, plus:
  {
    "class_name": "GateRunnerDO",
    "image": "./scripts/gate/Dockerfile",
    "image_build_context": ".",
    "instance_type": "standard-4",
    "max_instances": 150,
    "rollout_step_percentage": 100
  }
]
```

`GateRunnerDO`'s Dockerfile path is deliberately `./scripts/gate/Dockerfile`
(sibling to `apps/fleet/scripts/localci/Dockerfile`), not under
`apps/fleet/container/` where every other class's Dockerfile lives — see
Rollback, below, for why that placement matters and what it does and does
not buy.

### 4. R2/KV layout

R2: the **existing** `STUDIO_ARCHIVE` bucket (binding declared
`wrangler.example.jsonc:176`), not a new bucket — same reasoning
install-cache.ts already gives for reusing it
(`install-cache.ts:30-44`): a new prefix inside one bucket, never a new
bucket, since GateRunner never needs to read or write anything outside what
`STUDIO_ARCHIVE`'s existing R2 API token already scopes. Bytes never
transit the Worker/DO process — same `AwsClient`/SigV4-presigned-URL
mechanism install-cache.ts already proved (`install-cache.ts:20-28`): the
Worker mints a presigned URL, the GateRunner container streams the actual
transfer straight to/from R2.

New prefix: **`gate/`**, parallel to install-cache.ts's own `caches/`
prefix. Neither is a substring-prefix of the other (`caches/` vs `gate/` —
no collision), same non-collision argument install-cache.ts makes for its
own prefix choice against the archive module's prefix
(`install-cache.ts:30-34`).

Keys under `gate/`:

- `gate/<owner>/<repo>/baselines/<main-sha>-<lockfile-hash>/vite/…` — vite
  build cache.
- `gate/<owner>/<repo>/baselines/<main-sha>-<lockfile-hash>/cargo-target/…`
  — cargo target cache.
- `gate/<owner>/<repo>/runs/<run-id>/shard-<leg>.json` — one shard/leg's
  result JSON.
- `gate/<owner>/<repo>/runs/<run-id>/coverage/<leg>.json` — per-shard
  coverage blob, merged by the Workflow's fan-in step.

KV: new namespace, binding `GATE_KV`. One key shape:
`main-sha:<owner>/<repo>` → JSON `{ sha, lockfileHash, baselinePrefix,
updatedAt }`, written each time a baseline finishes building on `main`, read
by every PR's Workflow run to find its baseline cache without listing R2.

### 5. Instance type and limits

standard-4 is 4 vCPU, measured 11.65 GiB usable memory ceiling
(`apps/fleet/container/memguard.ts:5-6`, which cites that exact figure for
a standard-4 studio container; 12 GiB nominal per #715's own research note,
11.65 GiB is the measured headroom after reserving overhead). #715 proposes
`max_instances ≥ 150` for `GateRunnerDO`.

**Flagged, not just restated**: 150 × 4 vCPU = **600 vCPU** for this ONE
class alone, against the issue's own researched account-wide cap of 1500
vCPU. That is 40% of the entire account's compute ceiling committed to one
container class, before `StudioDO` (5 × standard-1 = 5 vCPU),
`StudioBigDO` (2 × standard-4 = 8 vCPU), `AgentDO` (3 × standard-1 = 3
vCPU) and `DeployDO` (2 × standard-1 = 2 vCPU) count against the SAME cap
(`wrangler.example.jsonc:196-241` — today's combined ceiling across those
four classes is 18 vCPU, far below 1500, so there is no live conflict
today). The question is whether 150 is sized to actual GateRunner demand or
just copied from "N can be as high as 30 shards, and we might run a few
PRs' gates at once": at N=24 shards + 4 fixed legs = 28 containers per PR,
3 concurrent PRs (today's autopilot cap, operator brief above) is 84
containers = 336 vCPU, well under 600 — so 150 has real headroom built in
for either a higher shard count or more concurrent PRs than today's 3.
**Open question for the operator**: is 150 an intentional buffer for a
higher future N or more concurrent gates, or should it be capped tighter
(e.g. to cover exactly 3 concurrent PRs × 30 shards = 90 instances = 360
vCPU) to leave more of the 1500-vCPU account cap free for the studio fleet
to grow past today's 10-30 studios without the two classes ever competing
for the same ceiling? This spec does not pick a number — it names the
arithmetic so the operator can.

### 6. Cost per PR

Same CF pricing-page figures the ci-steward spec already cites (memory
$0.0000025/GiB-s, CPU $0.000020/vCPU-s active only, disk $0.00000007/GB-s —
`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:100`,
dated 2026-09-25; the operator should re-check the current pricing page
before treating this as exact three weeks later).

One standard-4 instance (4 vCPU, 12 GiB), 10 minutes (600s) active, the p50
target from #715: mem `12 × 600 × 2.5e-6 = $0.018`, CPU
`4 × 600 × 2e-5 = $0.048`, disk negligible (well under $0.001 at this size).
**≈ $0.066/instance-run.**

Per PR, 28 containers (4 fixed legs + N=24 vitest shards, mid-range of
#715's 20-30): `28 × $0.066 ≈ $1.85/PR` in GateRunner compute alone. Add
Workflow billing (per-step + duration) — not computed here: no existing
file in this repo cites current CF Workflows pricing, unlike the
container-instance math above which is pulled straight off a cited pricing
page; the operator should pull that number off the CF pricing page the same
way before trusting a total. R2 storage/request cost for baselines + shard
JSON is small relative to the compute line (baselines are deduplicated per
main SHA + lockfile hash, not per PR) and is not broken out separately here.

Monthly run-rate, **illustrative only, PR volume unverified**: at an assumed
10 PRs/day/repo across the three repos named in #715 (fleetflare and its
two phase-2 repos, not reproduced here — public repo) — the operator to
confirm actual volume, no number for
this is cited anywhere in this repo — 30 PRs/day × $1.85/PR × 30 days ≈
**$1,665/month** in GateRunner compute. Against "near-unlimited CF credits"
(issue body) this is the number to sanity-check that claim against, not a
blocker this spec resolves on its own.

### 7. Rollout and rollback

**Rollout.** Phases, from #715's own body:

1. Workflow + `GateRunnerDO` + R2 cache, fleetflare only, behind
   `FLEET_GATE_RUNNER=off` default and `GATE_RUNNER_REPOS=rafarc21/fleetflare`.
2. Add #715's other two named repos to `GATE_RUNNER_REPOS` and each
   repo's own `fleet.json` gate block.
3. Default gate for all maestros (flag flips to `on` fleet-wide once phases
   1-2 hold their p50/p90 target over 10 PRs/repo, per #715's Target
   section).

A container/image change — which `GateRunnerDO`'s own Dockerfile is —
"rolls at image window" per #715's own constraint: the operator sets the
time, peers GO before a deploy that changes any running container's image.
Worker-only changes (the Workflow's own TypeScript, the flag, the KV
lookup) need no image window; only the `containers[]` entry's `image` field
changing does. Worker deploy for either half needs the wrangler-auth fix
#715 itself names as a precondition (same blocker the model-pool spec
depends on, `docs/superpowers/specs/2026-10-13-model-pool-design.md:72`).

**Rollback.** Two different reversibility classes, and this spec keeps them
separate on purpose:

- The flag (`FLEET_GATE_RUNNER=off`, or dropping a repo from
  `GATE_RUNNER_REPOS`) is a Worker-only, instantly reversible var flip — no
  image window, no container restart needed beyond the Worker picking up its
  own new `vars`.
- The container image is not instantly reversible once GateRunnerDO
  containers are live and running real PR gates — redeploying an older
  image is itself a new image-window deploy, same as any other container
  class.
- `apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS`
  (`merge-danger.ts:34-38`) names `apps/fleet/container/**` as one-way
  "container image build; replaces running studio containers on deploy."
  **GateRunnerDO's own Dockerfile at `apps/fleet/scripts/gate/Dockerfile`
  does NOT match that glob today** — it is a real image change (same
  blast radius as any `containers[]` image edit) that `merge-danger.ts`
  would currently wave through as an ordinary two-way change. This is a
  real gap this spec surfaces rather than quietly works around: either
  `ONE_WAY_GLOBS` needs a second entry for `apps/fleet/scripts/gate/**` (or
  wherever the Dockerfile ends up living) before GateRunnerDO ships, or the
  Dockerfile should move under `apps/fleet/container/` instead and accept
  the already-existing glob match. This spec does not decide which; it
  flags the gap for whoever writes the implementation plan.
- The constraint from #715 itself — "must not touch studio container class
  or rescue paths" — is met by construction: `GateRunnerDO` is its own DO
  class, its own container entry, its own Dockerfile, zero shared code path
  with `StudioDO`/`StudioBigDO`'s bringup (`container/studio-bringup.sh`) or
  rescue flow. Nothing in this design edits either.

## Config: `fleet.json` gate block

Per #715's own body: install cmd, test cmd, shard count, legs, path rules,
per repo. Illustrative shape (not implemented here):

```json
{
  "gate": {
    "install": "bun install --frozen-lockfile",
    "legs": ["typecheck", "lint", "invariants", "rust"],
    "vitestShards": 24,
    "vitestCmd": "bun run test --shard={i}/{n}",
    "pathRules": ["apps/fleet/**", "skills/**", "fleet/blueprint/**", "scripts/**"]
  }
}
```

`pathRules` mirrors the existing skip-fleet-check path filter
(`localci.sh:378-381`): a PR touching none of these paths skips the whole
gate the same way `localci.sh` sets `IMAGE=none` for a no-op diff today.

## CLI

`fleet gate-start <pr>` and `fleet gate-watch <pr>`, following this repo's
own dash-subcommand convention (`apps/fleet/cli/fleet.ts:3077-3145`:
`models-ls`, `models-assign`, not `models ls`). `gate-start` creates a
`GATE_WORKFLOW` instance for that PR (idempotent per PR+head-SHA, same
one-run-per-tested-tree idea `localci.sh`'s own run-id already encodes).
`gate-watch` polls the Workflow instance / `gate/verdict` status to a
terminal state and exits with the same convention `localci.sh` already
uses (`localci.sh:24`: 0 green, 1 red, 2 infra error, 3 a status POST
failed twice) so a maestro's gate script can swap one call for the other
without changing its own exit-code handling. Maestros' gate scripts call
these two instead of `cloud-gate.sh`'s current wait loop, once
`FLEET_GATE_RUNNER` is on for the target repo.

## Testing / validation plan

Before flipping `FLEET_GATE_RUNNER` default to `on` for any repo:

1. Unit: merge-tree step (port of `localci.sh:350-363`'s
   `git merge-tree --write-tree` / `git commit-tree` two-parent shape to
   TypeScript) against a fixture repo with a known conflicting and
   non-conflicting pair — exit-1-is-conflict, any other non-zero is a git
   failure reported in git's own words (same distinction `localci.sh:350-352`
   draws).
2. Unit: leg/shard fan-out — N shards requested, N GateRunnerDO instances
   invoked, fan-in blocks until all N report (or the Workflow's own
   per-step timeout fires) before posting a verdict.
3. Unit: `gate/verdict` state machine — pending → success only when every
   leg is `success`; any `failure` → `failure`; any `error` (timeout,
   crash, R2 write failure) → `error`, never silently downgraded to
   `failure`.
4. Live, phase 1, fleetflare only: run `fleet gate-start` against the same
   PR a Mac `localci.sh --native` run already scored, diff the pass/fail
   set. Any difference is an environment-drift bug (OS, toolchain version),
   filed before trusting GateRunner's verdict over the Mac one — mirrors
   the first-run comparison the ci-steward spec itself prescribes
   (`docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md:124`).
5. Measure p50/p90 wall time over 10 PRs/repo per #715's own Target
   section, before expanding `GATE_RUNNER_REPOS` to phase 2.
6. Re-probe the PAT's `Commit statuses: write` scope (question 1, above)
   against a real PR before relying on `gate/verdict` for any maestro
   decision.

## Decisions asked of the operator

1. Approve the shape above (Workflow `gate` + `GateRunnerDO`, `gate/`
   R2 prefix, new `GATE_KV` namespace, `FLEET_GATE_RUNNER` /
   `GATE_RUNNER_REPOS` flags) or redirect any of the seven questions'
   answers.
2. `max_instances` for `GateRunnerDO`: keep 150 (headroom for growth) or
   cap tighter to leave more of the account's 1500-vCPU ceiling free for
   the studio fleet (question 5).
3. Confirm or correct the illustrative PR-volume assumption in the cost
   section (10 PRs/day/repo) — the monthly run-rate number is only as good
   as that input.
4. Pick where `GateRunnerDO`'s Dockerfile lives: `apps/fleet/scripts/gate/`
   (outside `merge-danger.ts`'s current `ONE_WAY_GLOBS` reach — needs a new
   glob entry added before ship) or under `apps/fleet/container/` (already
   covered, no `merge-danger.ts` change needed).
5. Re-verify the PAT's `Commit statuses: write` scope (carried forward,
   unresolved since the 2026-09-25 ci-steward spec) before this design's
   implementation PR is written.
