# Operations

Everything an operator needs to know once a fleet is running: the sharp
edges around deploys and rollouts, and how CI works on this repository.
Moved out of the root [README.md](../README.md) so the front door stays
short — nothing here is condensed, only relocated.

The one page listing every environment variable — operator-facing vars,
secrets, computed-name families, and the container-/CLI-injected set a
studio's environment actually carries (STUDIO_NAME and friends — all
set by the Worker or the runtime, never operator config) — is
[docs/env-vars.md](env-vars.md).

## Things that will bite you

This section is the one worth reading twice. Every entry below was measured, not
predicted.

**A deploy replaces only the containers whose image actually changed.** Since
#98 (issue #84), the container images build reproducibly: an unchanged
`container/` — same pinned base images, same `SOURCE_DATE_EPOCH`, same
`repro-seal`-sealed layers — rebuilds to the exact same digest, cold, every
time (`scripts/image-repro-check.sh`, `test/bun/reproducible-images.test.ts`).
`scripts/deploy-containers-changed.ts` (issue #40) builds each container
image the way wrangler will and compares it against what is already deployed
(`wrangler containers list`/`info`, read-only): same registry digest, same
`max_instances`/`instance_type`, same logs setting -> no container is
replaced, and a Worker-source-only deploy leaves every running studio right
where it was. Touch `container/` (or a base image pin) and the digest
changes, and so does every studio built from it — still plan a deploy as a
container replacement whenever you know you're touching it. The probe still
needs docker and a logged-in wrangler, still cannot tell about a top-level
`unsafe` block change or a DO migration deleting/renaming/transferring a
container class, and either of those still forces the hard gate. See
[docs/setup.md](setup.md) for the exact comparison.

**A rollout replacement does not run the rescue push.** `recycle` and `destroy`
rescue uncommitted work to a branch first; a convergence-driven replacement does
not. Work that lives only in a container filesystem can be lost by a deploy.
`bun run deploy` runs `fleet rescue-all` (issue #251) itself as the
pre-deploy gate (issue #20; `--allow-unrescued` overrides, loudly) — it
commits and pushes every
running AND degraded studio's uncommitted work (main checkout and every
member git worktree, each to its own `fleet/rescue/...` ref), plus every
local branch not checked out anywhere and every stash entry holding unpushed
work, repo-wide — so a member subagent's own stash or an abandoned branch is
never invisible. A clean-but-unpushed checkout is rescued too, main checkout
included: if the tree has nothing uncommitted but HEAD holds commits no
remote-tracking ref already has (an upstream-less branch, or a plain `git
commit` nobody ever pushed), that HEAD is pushed with no new commit needed —
the same "clean but unpushed" coverage a member worktree gets, not a
main-checkout-only special case. A push rejected non-fast-forward retries
once to a freshly generated ref before it counts as a failure. It prints a
`skipped <id> (<state>)` row for every stopped/provisioning studio and for
any studio the container itself reports isn't actually running, and
exits non-zero only on a genuine rescue failure. Its last line is the
verdict: `pre-deploy gate SAFE`, or `<n>/<attempted> attempted studios not
rescued (<f> push FAILED, <t> TIMED OUT) -- pre-deploy gate UNSAFE; do NOT
deploy` on stderr. A "container not running" skip is not attempted. Push as you go regardless.

After every rescue, `fleet rescue-all` and `fleet recycle` print one line per
worktree: `<worktree>: pushed <ref>`, `<worktree>: nothing to push`, or
`<worktree>: FAILED (<step>)`. A rescue ref pushed from a `--depth 1` clone to
a remote without its history is a PARENTLESS snapshot (commit message
`fleet rescue snapshot of <sha> (shallow clone)`): `git show` / `git log -p`
list its whole tree as added. Diff it by tree instead:
`git fetch origin <ref> && git diff <base> FETCH_HEAD`.

**Rollout convergence takes minutes.** `wrangler containers info` keeps
reporting the old digest with an `active_rollout_id` until it finishes. A studio
spawned or recycled before convergence gets the old image.

**A studio's account is fixed when its container starts.** Rotating the Worker
secret reaches only containers created afterwards. `provision` does not change
it; `recycle` does.

**Three ways a healthy studio looks dead.** Reading the wrong tmux window (the
status bar's `*` marks the active one, and the lead lives in window 0); a
readiness verdict that is up to 300s stale right after a verb; and a lead that
has dispatched background subagents, which ends its turn and shows no spinner
while the real work runs underneath.

**`pane_current_command` answers alive-or-dead, never working-or-stopped.** It
reads `claude` for a lead mid-turn, a lead waiting on subagents, and a lead
stopped at a prompt alike.

**A Worker deploy during an in-flight gate run can break it.** Measured on
2026-10-16: a `gate` Worker redeploy with no container change left 39 leg
steps failing with `Attempt failed due to internal workflows error` (two
waves, about 2 min apart) and one `Network connection lost`, on a run of 24
legs. Those infra-class failures now re-run the gate once on the same head
(#1119: the status reads `rerun after infra error`), but a run that fails
again is a final error. Deploy the Worker at a lull. Per #1119, the maestro
tooling waits up to 10 min for zero running instances before it deploys.

## Clearing a dead claude account

Issue #141: an account whose org disabled Claude subscription access answers
every request with "Your organization has disabled Claude subscription
access for Claude Code · Use an Anthropic API key instead, or ask your admin
to enable access" — permanent, no reset, so failover marks it `dead` in
`fleet_state` (D1) and never selects it again, with NO auto-expiry (unlike an
ordinary rate-limit sighting, which self-clears after 24h). `fleet ls` shows
it — `dead account: <name> — seen <timestamp> — ...` — even when no studio is
currently parked on it, since several accounts can go dead in one org-wide
disable while every studio has already failed off them.

Once the org re-enables the account (or you've replaced its token), clear the
D1 row by hand — nothing does this automatically:

    wrangler d1 execute fleet --remote --command \
      "DELETE FROM fleet_state WHERE key = 'account-limit:CLAUDE_CODE_OAUTH_TOKEN_2'"

(substitute the real secret name — `CLAUDE_CODE_OAUTH_TOKEN`, `_2`, `_3`, ...
— `fleet ls`'s "dead account:" line names it). The account is eligible for
failover again on the very next tick that reads the fleet-wide limit map.

## Studio test credentials

Issue #279. A studio fetches one staging test login with `fleet creds get
<name>`. The Worker holds an Infisical machine identity (Universal Auth),
logs in, reads that one secret and returns it to the asking studio only.
No studio ever holds an Infisical credential.

Setup:

1. Create an Infisical machine identity with Universal Auth. Give it read
   access to the staging/dev environment's `/test-accounts` folder only.
2. `wrangler secret put INFISICAL_CLIENT_ID` and `wrangler secret put
   INFISICAL_CLIENT_SECRET`.
3. Set the `TEST_CREDS_BY_REPO` var (JSON; locations, never values):

       {"owner/repo": {"viewer": {"workspaceId": "<project id>",
         "environment": "staging", "secretPath": "/test-accounts",
         "key": "VIEWER_PASSWORD"}}}

4. Optional: `INFISICAL_API_URL` for a self-hosted instance (https only).

The guard refuses the WHOLE config, and the route answers 503, if any entry
uses an environment other than staging/dev/development/test, a secretPath
outside `/test-accounts`, or an admin-looking name, key or path. Any of the
three settings absent: 503 "test creds not configured". A name not listed
under the calling studio's own repo: 403.

Every call writes one `{"event":"fleet_creds", studio, name, outcome, at}`
line to the Worker logs. The value is never logged.

## Model pool

Issue #717. Non-Claude studio leads (`--lead glm`/`kimi`/`deepseek`) route
through AI Gateway `default` across a pool of Workers AI models (GLM,
Kimi, DeepSeek) instead of one fixed model, with per-studio main-model
assignment, small-role pick, 429/3021 overflow to the next pool model, and
daily quality-based auto-demotion. Off by default (`LEAD_MODEL_POOL`, see
`docs/setup.md`); `LEAD_MODEL_POOL` off keeps today's GLM-only behavior.

`fleet models` lists every pool model (key, id, state, smoke-passed) and
every studio's current main-model assignment:

    fleet models
    fleet models assign <studio> <model>   # model = pool key (glm|kimi|deepseek) or full id
    fleet models promote <model>
    fleet models demote <model>

`fleet spawn --lead glm|kimi|deepseek` boots a studio's lead on this
fleet's own translation route instead of a Claude account, with `kimi`/
`deepseek` pinning that pool model as the studio's main model (instead of
the round-robin default) — same as `fleet models assign` on a fresh
studio.

A model only becomes eligible for the pool (`smokePassed: true` in
`apps/fleet/src/llm/models.ts`) after it has actually passed a live smoke
test: `bun scripts/model-smoke.ts glm|kimi|deepseek` from `apps/fleet/`,
which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the
environment and drives one tool call, a multi-turn tool-result reply, and
a streamed reply through the Anthropic↔OpenAI translator against the real,
live Workers AI binding. Run this by the maestro only, from your own Mac
or ops environment — never inside a studio container, since no Cloudflare
credentials exist there.

Auto-demotion (daily cron, pool on only): a model is demoted to `demoted`
state when, over its last 10 closed PRs (minimum 5 PRs before it is even
eligible to be judged), its first-try CI pass rate is 25 or more points
below the best model's, or it has 2 or more post-merge reverts.

## CI

GitHub Actions runs natively on this repository — four workflows:

| Workflow | Trigger | What it runs |
|---|---|---|
| [`check`](../.github/workflows/fleet-check.yml) | PR/push touching `apps/fleet/**`, `skills/**`, `fleet/blueprint/**` or `scripts/**` | `bun install`, `bun run check` (types, all tsconfig projects), `bun run test` (vitest-pool-workers), `bun run bun-test` (container-level; the job installs tmux and Chromium first) |
| [`english`](../.github/workflows/english-check.yml) | every PR/push, no path filter, so no file is exempt | `bun run apps/fleet/scripts/english-check.ts` |
| [`one-way-door`](../.github/workflows/one-way-door.yml) | every PR, no path filter; no push trigger (there is no PR to label on push to `main`) | `apps/fleet/scripts/merge-danger.ts`'s `classify()` against the PR's diff; applies or removes the `one-way-door` PR label accordingly — see below |
| [`sensors`](../.github/workflows/sensors.yml) | hourly cron (`17 * * * *`) + `workflow_dispatch` | record-only sensors — rewrites the pinned "fleet: sensor burn log" issue with main-only fleet-check failures (last 50 runs), known-flaky count and dampener state; files no tasks, gates nothing (issue #187) |

A PR whose diff touches none of `check`'s watched paths never triggers that
workflow at all — no `check` run appears for it on that commit, unlike a path
match, which always does. `english` has no path filter, so every commit gets
one. Read a PR's status the normal way:

```bash
gh pr checks <pr-number>
gh api repos/<owner>/<repo>/commits/<sha>/check-runs
```

### One-way-door classification

Issue #161: a deterministic, path-based classifier that overrides an
agent's own self-graded reversibility judgment on a PR (studio leads
already self-assess reversible/irreversible before acting — this is a hard
override on top of that, for CI).

[`one-way-door`](../.github/workflows/one-way-door.yml) (added 2026-10-11,
with the repo's native Actions setup) runs on every PR, no path filter (a
docs-only PR must still come back two-way): it diffs the PR against its
base SHA, classifies the changed paths with
`apps/fleet/scripts/merge-danger.ts`'s `classify()`, applies the
`one-way-door` PR label on a match or removes it otherwise, and lists every
matched path in the check's own step summary — `gh pr checks` shows it
under the job name `classify`, not `one-way-door`. See `ONE_WAY_GLOBS` in
that script for the authoritative list of forced one-way-door paths and why
each one is on it — not duplicated here, to avoid the table drifting out of
sync with the code. The job itself always succeeds; it classifies, it does
not gate.

`apps/fleet/scripts/localci/` — a Mac-based daemon that ran the same two
lanes and posted them as `local-ci/*` commit statuses — predates this native
Actions setup and is superseded by it: GitHub Actions gates merges now, not
the daemon. The scripts (`localci.sh`, `localci-daemon.sh`,
`known-flaky.txt`) still exist for reproducing a lane on a Mac by hand
(`localci.sh <pr-number|sha> --dry-run` runs it without posting anything),
but no longer gate a merge or post a commit status.

## Gate git bundle (#1080)

Operator steps for the one-bundle-per-run path. Off by default, in two switches. Both must be on.

1. **Fleet-wide flag:** `GATE_BUNDLE=1` turns the bundle step on. It is the kill switch. Set it only after the gate container image that understands the `bundle` leg is live. Before that, an old image runs `bundle` as a normal clone-and-checkout leg, one extra serial leg per run.
2. **Per-repo opt-in:** a repo's gate block in `fleet.json` sets `"bundle": true`. Absent or `false` means every leg of that repo clones, even with `GATE_BUNDLE=1`. A PR that changes `fleet.json` runs both the base's and the head's legs, so the bundle is used only when every block that runs legs opts in.
3. **Range parity rule:** opt in only a repo whose legs read no git history beyond the checked-out tree. A leg that reads history by range, such as `git log origin/<base>..HEAD`, `git diff origin/<base>...HEAD`, or a range-based secret scan, sees a different range on the snapshot: the snapshot has no `origin` remote, four shallow commits and no tags. Such a repo stays off until range parity exists, that is, legs get an `origin` remote with the base ref and the full PR range, so those commands match a clone. The config parser does not reject these repos. The opt-in is the guard.
4. **R2 lifecycle:** add a rule on the archive bucket that expires objects under the prefix `gate-bundles/` after 1 day. Bundles live under their own top-level prefix because a lifecycle rule matches a plain prefix only, and `gate/*/*/bundles/` cannot be expressed.
5. **Cap:** bundles over `MAX_BUNDLE_BYTES` (256 MiB) are not uploaded, and every leg clones. Measured snapshot sizes, local `file://` runs of the PR's own `runGate`: a small repo 6.4 MiB, a mid-size consumer 181 MiB (fits), a large consumer 311 MiB (over the cap, so its legs clone). The cap is unchanged; raising it is a separate decision.
