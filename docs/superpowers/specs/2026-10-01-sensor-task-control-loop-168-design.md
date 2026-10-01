# Sensor-to-task control loop with dampener baseline — design

Issue: https://github.com/rafarc21/fleetflare/issues/168. Date 2026-10-01. Status: proposal (spike). No auto-filing enabled. No CI gate wired live. No `studio.md` edit. The one piece of code this doc ships is a read-only measurement script (`apps/fleet/scripts/sensors/measure.sh`) — it files nothing, posts nothing, writes no state.

## Why

Issue #168 asks for a cron sensor that watches four signals (main CI failures, the known-flaky list, Worker exceptions, dead-account sightings) and files small board tasks at a capped rate, with a dampener that fails CI if a sensor count rises past main's own baseline, and a visibility invariant: every auto-filed task, the rate cap, and the current burn all shown somewhere. The issue is explicit that the spike's output is a design doc plus measured numbers — no auto-filing without operator approval. This doc compares the four sensors on measurability, proposes a dampener rule and a rate-cap/visibility mechanism, and names exactly which two sensors can ship first without new credentials or new Worker code, and which two are blocked and on what.

## Finding: GitHub Actions is live and native today — supersedes older guidance

Some older sessions carry guidance that "GitHub Actions is disabled on rafarc21/fleetflare" and that CI runs only through a Mac-local daemon (`apps/fleet/scripts/localci/`). That was true historically (see `docs/superpowers/specs/2026-09-25-release-studio-ci-steward-design.md`, written six days before this one, which opens with "GitHub Actions off on rafarc21/fleetflare (billing)"). It is no longer true. `docs/operations.md`'s own CI section says so directly:

> GitHub Actions runs natively on this repository — two workflows, on every pull request and every push to `main`.

Confirmed in-repo: `.github/workflows/fleet-check.yml` (triggers on `pull_request` and `push` to `main`, path-filtered to `apps/fleet/**`, `skills/**`, `fleet/blueprint/**`, `scripts/**`) and `.github/workflows/english-check.yml` (triggers on every `pull_request`/`push` to `main`, no path filter). `docs/operations.md:123-129` names the daemon and `known-flaky.txt` as superseded — they still exist for reproducing a lane on a Mac by hand, but no longer gate a merge or post a commit status. Any sensor design built against the daemon's `local-ci/*` commit statuses would be reading a dead signal. This doc is built against Actions run history instead (see sensor 1).

## The four sensors

### 1. Main CI failures — measurable today, via run history, not commit statuses

**What it is.** A rising rate of `fleet-check.yml` (or `english-check.yml`) failures on `main`.

**Where the data lives.** GitHub Actions run history, read with `gh run list`, not commit statuses. Commit statuses (`GET /repos/{o}/{r}/commits/{sha}/status`) are the old daemon's signal and are empty on this repo now — spot-checked directly against the head commits of 5 recently merged PRs, every one returned `"statuses": []`:

```
gh api repos/rafarc21/fleetflare/commits/<merged-PR-head-sha>/status -q '.statuses'
→ []   (all 5 checked)
```

`check-runs` (native Actions) is the live signal, but even that has a trap for a naive sensor: **a merged PR's own final head-commit status is tautologically always green**, because the merge gate requires it before merge is allowed. A sensor that reads "is the latest commit on main green" will read 100% green forever and never see a failure that happened, got fixed, and then merged. The correct read is **run history** (`gh run list`), which keeps every attempt, not just the final one.

**Measured** (`apps/fleet/scripts/sensors/measure.sh`, run 2026-10-01T10:02:44Z):

```
## CI failures — fleet-check.yml, all branches (last 100 runs)
      7
     16 failure
     77 success

## CI failures — fleet-check.yml, main only (last 50 runs; the dampener baseline)
      2
      1 failure
     47 success

## CI failures — english-check.yml, all branches (last 100 runs)
    100 success
```

All-branches (PR) noise is expected and higher — PRs iterate through red before merging, so 16/100 failing there is not itself a signal of anything broken. **`main`-only is the real baseline candidate**: 1 failure in 50 runs, ≈2%. `english-check.yml` shows zero failures across the sampled 100 runs — flag this as a candidate for `skills/retro-ritual/SKILL.md`'s "prune" category (a check with no measured signal is a candidate for review), noted here only — this spike does not act on it.

Reproduce: `bash apps/fleet/scripts/sensors/measure.sh`.

### 2. Known-flaky list — measurable today, trivially

**What it is.** The count of tests on the local flake-allowance list.

**Where the data lives.** `apps/fleet/scripts/localci/known-flaky.txt`, a plain comment-tagged text file, one test path per line (`test/<path>  # #<issue> <why>`), checked into the repo.

**Measured:** `grep -c '^test/' apps/fleet/scripts/localci/known-flaky.txt` → **2** entries (issues #256 and #382, both named in the file's own comments). No API, no auth, no network — the cleanest of the four sensors by a wide margin.

### 3. Dead-account sightings — NOT measurable from inside this studio today

**What it is.** An account the fleet has marked `dead` (`apps/fleet/src/studio/accounts.ts`'s `dead?: true` field, D1-persisted, set once an account is confirmed org-disabled — issue #141).

**Where the data lives.** D1-side (`fleet_state`), surfaced two ways today:
- `GET /studio/accounts` (`apps/fleet/src/studio/routes.ts:442`), a Worker HTTP route.
- The operator's Mac CLI's `fleet ls --json` → `accounts[].dead`, formatted by `formatDeadAccounts` (`apps/fleet/cli/readiness-format.ts:595`), which prints every dead account unconditionally (not filtered to whichever studio is currently parked on it) precisely because a dead account with no studio currently on it is a real case a per-studio view would otherwise hide.

**The gap.** Neither path is reachable from inside a studio. The in-container `fleet` binary every studio actually runs (`apps/fleet/container/studio-fleet`) has no `ls` verb at all — its usage banner is exhaustive:

```
usage: fleet spawn <role>[--<n>] [--instance <n>|next]
       fleet resume <role>[--<n>] [--instance <n>]
       fleet task ls | fleet task show <n> | fleet task report <n>
       fleet task state <n> <working|input_required|awaiting_merge|failed>
       fleet task new [--studio <id>] | fleet task assign <n> <studio-id> [--why <text>]
       fleet memory ls | fleet memory compact
```

Nothing in that list reads account state. A cron sensor for this literally cannot be built today without new plumbing — either a new read-only route the in-container binary is taught to call, or exposing the existing `/studio/accounts` route to whatever process runs the sensor. This is a real gap, not a TODO to wave past: it is out of scope for this spike and is named explicitly as BLOCKED below.

### 4. Worker exceptions — NOT measurable today, by design

**What it is.** Uncaught exceptions thrown inside the Worker's own request/cron handlers.

**Where the data could live.** `wrangler.example.jsonc:33` already turns on Cloudflare Workers Logs (`"observability": { "enabled": true }`), which would capture these server-side — but reading them back needs a Cloudflare Analytics/Logs-scoped credential, and **no studio holds any Cloudflare credential today** (house rule; confirmed directly in this container — `env | grep -i cloudflare` returns only `CLOUDFLARE_NODE_ID`/`CLOUDFLARE_APPLICATION_ID`/etc. placement metadata, no `CLOUDFLARE_API_TOKEN`, no `CLOUDFLARE_DEPLOY_TOKEN`). There is also no in-repo capture of exceptions today outside Workers Logs — `apps/fleet/src/events/` (`schema.ts`'s `EventKind`: `task`/`question`/`report`/`decision`/`escalation`/`human`/`approval_request`/`approval`) is agent-to-agent board messaging, unrelated to runtime exceptions.

**Two options, named, not built:**
- **(a) New scoped read-only Cloudflare Analytics token**, held by the operator and used Worker-side only (never handed to a studio — consistent with the existing no-deploy-credential-in-a-studio rule). Reads Workers Logs/Analytics Engine for exception counts.
- **(b) Worker-side try/catch capture into a new D1 table.** The Worker already holds D1 access; wrapping its own handlers and writing exception rows to a table it already has write access to needs no new credential at all — cheaper, and consistent with how `fleet_state` and the rest of the Worker's own state already works.

Recommend **(b)** as cheaper and credential-free, but this spike builds neither — both are BLOCKED pending an operator decision (see closing section).

## Dampener design

The issue's dampener rule: "CI fails if a sensor count rises vs main's baseline." Using sensor 1's measured `main`-only baseline (1 failure / 50 runs ≈ 2%) as the worked example:

- **Baseline** = failure rate over a trailing window on `main` (e.g. last 50 runs), recomputed each time the dampener runs — not a hardcoded number, since the real rate will drift as the test suite and the repo change.
- **Comparison rule, proposed (not mandated):** flag a rise when the CURRENT trailing window's failure count exceeds `baseline_count + N` for a fixed small `N` (e.g. baseline 1/50 → flag at 2+/50), rather than a percentage-rise threshold. Reasoning: at this sample size (50 runs), a percentage threshold is noisy — one extra failure is already a 100% relative rise off a baseline of 1, which would false-positive on routine variance. An absolute-count-plus-slack rule tracks real signal instead of amplifying small-sample noise. This is a recommendation; the exact `N` and window size are decisions for the operator (see closing section), not something this spike fixes.
- Same shape applies to the known-flaky sensor: baseline = current count (2), dampener fires on any net increase past a small slack, since this list is small enough that even +1 is a meaningful, reviewable event.

## Rate cap + visibility invariant

Issue #168 requires: every auto task on the board, the rate cap, and the current burn, all visible somewhere — and a capped filing rate. Proposed mechanism, mirroring an existing pattern in this repo rather than inventing a new one:

- **A dedicated `auto-sensor` label** on every task a sensor files, so the board itself is query-filterable to exactly this population (`gh issue list --label auto-sensor`) without any extra bookkeeping.
- **A pinned tracking issue**, rewritten on every sensor run, the same pattern `fleet/blueprint/studios/maestro/studio.md:104` already uses for its wave log ("Comment the wave on the pinned board issue `fleet: maestro wave log`. That issue is the wave history; nothing else is."). A pinned `fleet: sensor burn log` issue, its body rewritten each run with the rate-cap value, the current window's burn against that cap, and a per-sensor breakdown, gives one place that shows the whole invariant at a glance — same shape as the precedent, not a new convention.

Both are recommendations; the operator picks the exact cap number (closing section).

## Where sensors would actually run

Two live options, compared on what credentials/infra each already has:

| | Scheduled GitHub Action | Worker cron trigger |
|---|---|---|
| New credential needed | None — `gh` is already usable with the repo's own token | Already has D1 + GitHub App credentials (`src/studio/credentials.ts`) |
| Reaches sensor 1 (CI failures) | Yes — `gh run list` is exactly this | Yes, same API, with the App's token |
| Reaches sensor 2 (known-flaky) | Yes — the file is in the checkout | Yes |
| Reaches sensor 3 (dead-account) | No — D1 is not reachable from a GH Action runner | Yes, D1 is already available Worker-side (still needs the route/plumbing gap named above) |
| Reaches sensor 4 (Worker exceptions) | No | Only after (a) or (b) above is built |
| New infra | Zero — a new `.github/workflows/*.yml`, scheduled (`on: schedule`) | None if piggybacking the existing cron entry point, but needs new route/handler code |

**Recommendation: split by what's already reachable.** Sensors 1 and 2 (CI failures, known-flaky) ship first via a scheduled GitHub Action — cheap, no new credential, everything they need is already `gh`-reachable from a runner with zero Worker changes. Sensors 3 and 4 (dead-account, Worker exceptions) are explicitly **BLOCKED** pending the plumbing/credential decisions named in their sections above — they cannot be built today without new code or a new credential, and neither is in scope for this spike.

## No auto-filing enabled by this spike

Nothing in this PR files a board task, edits a CI workflow, or wires a gate. The measurement script (`apps/fleet/scripts/sensors/measure.sh`) only reads (`gh run list`, `gh api ... -q`, `grep -c`) and prints; it makes no POST call anywhere. A follow-up task, after the operator picks the numbers below, would wire real filing — starting from the two unblocked sensors, behind the rate cap and dampener this doc proposes, never the two blocked ones until their named gaps are closed.

## Decision asked of the operator

1. Which sensor(s) to build first. Recommend: CI-failure (sensor 1, `main`-only baseline) and known-flaky (sensor 2) — the only two needing no new credential and no new Worker code (ship as a scheduled GitHub Action).
2. The rate cap number (tasks filed per window, e.g. per day) for the sensor-to-task filer, once it's built.
3. The dampener threshold rule: accept the proposed absolute-count-plus-slack form (`baseline_count + N`), pick a window size and `N`, or specify a different rule (e.g. percentage-based) instead.
4. Whether to grant the Worker a scoped read-only path to dead-account/exception data, and if so, which of the two named options to pursue: (a) a new scoped read-only Cloudflare Analytics token (operator-held, Worker-side only), or (b) Worker-side try/catch exception capture into a new D1 table (no new credential). Also whether to build the dead-account route/plumbing gap (sensor 3) at all, and on what timeline.
