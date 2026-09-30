# Operations

Everything an operator needs to know once a fleet is running: the sharp
edges around deploys and rollouts, and how CI works on this repository.
Moved out of the root [README.md](../README.md) so the front door stays
short — nothing here is condensed, only relocated.

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

## CI

GitHub Actions runs natively on this repository — two workflows, on every
pull request and every push to `main`:

| Workflow | Trigger | What it runs |
|---|---|---|
| [`check`](../.github/workflows/fleet-check.yml) | PR/push touching `apps/fleet/**`, `skills/**`, `fleet/blueprint/**` or `scripts/**` | `bun install`, `bun run check` (types, all tsconfig projects), `bun run test` (vitest-pool-workers), `bun run bun-test` (container-level; the job installs tmux and Chromium first) |
| [`english`](../.github/workflows/english-check.yml) | every PR/push, no path filter, so no file is exempt | `bun run apps/fleet/scripts/english-check.ts` |

A PR whose diff touches none of `check`'s watched paths never triggers that
workflow at all — no `check` run appears for it on that commit, unlike a path
match, which always does. `english` has no path filter, so every commit gets
one. Read a PR's status the normal way:

```bash
gh pr checks <pr-number>
gh api repos/<owner>/<repo>/commits/<sha>/check-runs
```

`apps/fleet/scripts/localci/` — a Mac-based daemon that ran the same two
lanes and posted them as `local-ci/*` commit statuses — predates this native
Actions setup and is superseded by it: GitHub Actions gates merges now, not
the daemon. The scripts (`localci.sh`, `localci-daemon.sh`,
`known-flaky.txt`) still exist for reproducing a lane on a Mac by hand
(`localci.sh <pr-number|sha> --dry-run` runs it without posting anything),
but no longer gate a merge or post a commit status.
