# Operations

Everything an operator needs to know once a fleet is running: the sharp
edges around deploys and rollouts, and how CI works on this repository.
Moved out of the root [README.md](../README.md) so the front door stays
short — nothing here is condensed, only relocated.

## Things that will bite you

This section is the one worth reading twice. Every entry below was measured, not
predicted.

**Every deploy replaces every container.** The image build is not reproducible,
so even a change touching only Worker source produces a new digest and a fresh
rollout. Plan a deploy as a container replacement, always.

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

## CI

GitHub Actions is disabled on this repository (no CI spend). The workflow
files in `.github/workflows/` stay as the lane definitions. CI runs on the
operator's Mac instead, and posts two commit statuses on each PR head:

| Context | Lanes |
|---------|-------|
| `local-ci/fleet-check` | `bun install`, `bun run check`, vitest (Mac); `bun run bun-test` (Linux, docker) |
| `local-ci/english` | `apps/fleet/scripts/english-check.ts` |

The tested tree is the PR head merged onto `origin/main`, so a PR that
conflicts with main fails with "conflicts with main". A PR that touches no
`apps/fleet/`, `skills/` or `fleet/blueprint/` path still gets
`local-ci/fleet-check`, as success with a "skipped" description.

```bash
S=apps/fleet/scripts/localci
$S/localci.sh <pr-number|sha> [--dry-run]    # one run; --dry-run prints statuses
$S/localci-daemon.sh once --dry-run          # which open PRs lack a status
$S/localci-daemon.sh install [--dry-run]     # launchd agent, polls every 120s
$S/localci-daemon.sh uninstall
gh api repos/<owner>/<repo>/commits/<sha>/status   # read the result
```

- Runs are serial. The lanes hold the Mac-wide gate lock
  (`/tmp/fleetflare-gate.lock`, `lockf`), one heavy job at a time on the
  machine.
- Logs, and a `result.json` with counts, failing test names and the tested
  tree hash, land in `~/Library/Logs/fleetflare-localci/runs/<run>/`.
- A failure only in a file listed in `scripts/localci/known-flaky.txt` reruns
  that file alone, once. The status description says when a rerun happened.
- A status POST that fails is retried once, then fails the run (exit 3).
- A hung lane is killed at `LOCALCI_LANE_TIMEOUT` (2400s); a lane killed by a
  signal, and a run killed before it finished (swept at the next start), post
  `error`, never success or failure.
- The daemon runs a head with no `local-ci/fleet-check` status, or an `error`
  one older than 30 min. One daemon per machine; polls no faster than 30s.
- Install the daemon from a checkout that tracks `main`: launchd runs the
  scripts from the path you install from.
- No local-ci status on a head means it has not run yet. It never means green.
