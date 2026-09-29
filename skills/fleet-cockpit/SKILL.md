---
name: fleet-cockpit
description: Use when work should run in the cloud fleet rather than locally — spawning or attaching a studio, filing board tasks, checking what the fleet is doing, adopting an existing issue, or deciding between the fleet and local Orca worktree agents. Covers `ff`, `fleet`, studio ids, and the traps that make a healthy fleet look broken. Read this before reaching for a local agent on anything that should outlive the laptop.
---

# Fleet cockpit

The fleet runs Claude sessions in Cloudflare containers. They keep working
when the laptop closes, and they carry guardrails a local session does not.

`ff` and `fleet` are globally installed. They work from any repo.

## Decide first: fleet or local

> **`dev` is DEAD (2026-09-07).** Read "local" below as a local **Orca**
> worktree agent (`orca worktree create`) or this session. Routing rule lives in
> `~/.claude/CLAUDE.md` `## Agent Dispatch`.

| use the fleet | use local Orca agent / this session |
|---|---|
| real deliverables | quick exploration, throwaway |
| work that must outlive the laptop | needs your local filesystem or running services |
| anything wanting the board, guardrails, verification checklist | a one-file edit you will review in 30 seconds |
| parallel work across repos | you need to watch every keystroke |

The fleet costs a container boot and a task on the board. **Provisioning
takes about 5 minutes** — measured 2026-09-16, `acme-os--maestro` spawned
09:18, `provisioned` 09:23. Below that threshold, work locally.

**Leave a provisioning studio alone.** Destroying and respawning inside that
window restarts the clock. One operator killed three healthy studios in a row
this way and concluded the fleet was broken.

## The model

A **studio** is one container: one claude session (the **lead**) plus member
subagents. Its id is `<repo>--<role>` — `websites--web-studio`,
`beta--maestro` — or `<repo>--<role>--<n>` for the second and later studio of
the same role in one repo (issue #269): `websites--pilot--2`,
`beta--web-studio--3`. There is no `--1`; instance 1 IS the bare
`<repo>--<role>` id, and every id that existed before #269 keeps meaning
exactly what it always did.

**Leads never implement.** A PreToolUse hook refuses their Edit/Write and
their file-writing Bash forms. Implementation goes to members. This is
enforced, not requested — if a lead tries, the call is blocked and it is
told to dispatch.

**Maestro is the interface.** Ideas go to it in prose; it classifies, writes
task specs, spawns studios, reports status. Other studios never message it —
they report to the board.

**Vocabulary (the operator 2026-09-18): CTO = the operator, the human. Maestro = the
coordinator role, on two substrates with ONE rulebook** — the *local* maestro is
the Claude session the operator talks to (formerly called "CTO"); the *cloud* maestro is
the `<repo>--maestro` studio, running while he is away. `org.json` still lists a
`cto` role and an `operator` node from before this; those are being reconciled
in the blueprint (board task).

A maestro uses subagents only when the output INFORMS or ADMINISTERS (status,
PR checks, grooming, closing issues, research, briefs, creating a worker) —
never for the deliverable, which goes to a worker. It arms monitors in its own
session, never inside a subagent. Full rule: `~/.claude/CLAUDE.md`
`## Agent Dispatch`.

Roles: `maestro`, `web-studio`, `release-studio`, `pilot`, `scratch`.

**One studio per role per repo.** The id is `<repo>--<role>`, so there is
exactly one `acme-os--web-studio`. "One studio per task" and "every task on a
web-studio" cannot both be true for two tasks on the same repo — pick one.
Several related tasks can share one studio; see `fleet-dispatch-grouping-rule`.

**Where a role is defined — studio first.** `provision.ts` tries
`fleet/blueprint/studios/<name>/studio.md` BEFORE `fleet/blueprint/roles/<name>.md`.
`roles/` holds only `pilot` and `scratch`; `maestro`, `web-studio` and
`release-studio` live under `studios/`, with their members in
`studios/<name>/members/*.md`. Reading only `roles/` makes three healthy roles
look undefined. That misdiagnosis has already been made once.

**Who may spawn whom — the org chart, `fleet/blueprint/org.json`.** In-container
`fleet spawn <role>` is gated by `maySpawn(org, parent, child)` and answers
**403 "spawn not permitted by org chart"** for any edge not listed:

| a lead of… | may spawn |
|---|---|
| `maestro` | `web-studio`, `release-studio` |
| `pilot` | `scratch` |
| `web-studio`, `release-studio`, `scratch` | **nothing** |

So a `web-studio` lead gets 403 for every role. That is the gate working, not
a dead capability. The in-container help says "within this studio's org-chart
edges" and does not list them — this table does. A lead that cannot fan out
to peers fans out to its OWN member subagents instead, which is usually what
you wanted anyway. (`org.json` also lists `cto -> release, qa, dev`; none of
those four roles has a definition file, so those edges resolve to nothing.)

**A lead cannot write files, so it cannot commit its own report.** The same
hook that refuses its Edit/Write refuses the markdown deliverable too. A lead
that finished a long analysis and never dispatched a member to commit it left
50k characters recoverable only from issue comments. When a brief asks for a
committed file, the lead must dispatch a member to write and commit it — say
so in the brief. The envelope comment on the board is the lead's own channel.

## Start here

```
ff                      # this repo's maestro — spawn if absent, then attach
ff web-studio           # another role, same repo
ff web-studio "<task>"  # file the task, spawn a studio FOR it, attach
ff web-studio 42        # adopt EXISTING issue #42, spawn a studio on it
ff pilot --new "<task>" # an ADDITIONAL pilot beside the one already running
```

Repo comes from your cwd's git remote. Run `ff` in `~/code/example-repo` and you
get `example-repo--maestro` working on example-repo.

`ctrl-]` detaches. The studio keeps running.

## More studios per role (issue #269)

A repo used to get exactly one studio per role, so only three could implement
at once (`web-studio`, `pilot`, `scratch` — `maestro` and `release-studio` do
not implement). That ceiling is gone:

```
fleet spawn pilot --new              # lowest free instance: websites--pilot--2
ff pilot --new "<task>"              # same, then attach, with the task filed
fleet task assign 42 pilot--2        # move task 42 to that second pilot
fleet task assign 42 websites--pilot--2   # same, by full id, from any folder
```

`--new` takes the **lowest free** number, so destroying `--2` and spawning
again reuses `2` rather than drifting to `--17`. On a role with nothing
running it lands on instance 1 (the bare id) — it asks for a free slot, not
specifically a second one. Without `--new`, nothing changed: you target
instance 1 and get `409 studio exists` if it is already there.

Every verb that takes an id already takes an instance id: `fleet ls`,
`inspect`, `attach`, `tabs`, `destroy`, `recycle`, `provision`, `rescue-all`,
`studio:<id>` board labels, and the `studio-<id>` Orca sidebar rows.

Orca never shows the `--<n>` part of an instance id. It folds hyphen runs:
`demosite-life--web-studio--2` lives at folder
`studio-demosite-life-web-studio-2`, row title `demosite-life · web-studio#2`.
Grep Orca for the folded folder or `role#n`, never the fleet id. `fleet ls`
ROW maps them for you (#297).

**One Claude account, shared by the whole fleet.** This is the caveat to read
before spawning instances: more studios do not buy more usable capacity. They
let more leads run *concurrently* against the SAME rate-limited account, and a
session limit hits every studio in the fleet at once (`fleet ls` then shows
`rate-limited until <time>` on all of them — see the READY column notes below).
Spawn a second instance because two pieces of work genuinely need to run in
parallel, not to go faster through a limit.

**Each instance works on its own branch.** They share the repo and the
checkout convention; they must never share a branch. This is a house rule in
every studio's system prompt, not a suggestion — two leads pushing to one
branch is the collision this feature exists to avoid.

The fleet-wide cap is unchanged and unrelated: 100 studios total
(`MAX_STUDIOS`).

## Verbs

`fleet help` is authoritative and always current. Read it rather than
trusting a list here.

The ones worth knowing before you need them:

- **Never `fleet ls | head`** — rows sort by id, a cut hides whole repos. Filter with `grep '^<repo>--'`; check the row count against line 1 (`STUDIOS: <n> total, <b> billing — …`).
- `fleet ls` — what is alive. **Trust the READY column, not STATE.** STATE
  can be stale; READY is a real container check with a timestamp. READY has
  exactly two values that assert anything:
  - `provisioned` — harness intact, claude running in `studio:claude`
  - `bare: <reason>` — container up, agent or harness missing
  - **`?` means the periodic check has not run yet.** Not broken, not booting,
    not working. `? <reason>` means the check ran and was inconclusive. Never
    read either as good or bad, and never report a studio as "dispatched and
    working" on `?`. The check runs on a schedule you cannot force.
  - **Rate-limit values override the above** on a running/degraded row
    (issue #99). Read from the 300s failover pane capture:
    - `rate-limited until 13:30Z` — claude account limit; lead can do nothing
      until then. Wakes are refused. Do not re-wake, do not recycle.
    - `limit modal open — Esc to dismiss (ff <id>)` — select modal with spend
      options ("Upgrade", "Add funds") on screen. Nothing unattended types
      into it. Dismiss by hand: `ff <id>`, press Esc, detach, re-assign.
    - `rate-limited (reset time not shown)` — limit block, reset unreadable.
- `fleet task ls` — the board for this repo. Includes **backlog**: issues
  with no studio assigned, including ones you filed by hand or from a phone.
  Route one with `fleet task assign <n> <role>`.
- `fleet recycle <id>` — the ONLY way an image change reaches a running
  studio. Destroys the container; the session is rescued first.
  **Container cannot answer → rescue impossible → recycle REFUSES (409)** and
  names last synced snapshot age (#96). `--discard-unsynced` proceeds,
  discarding everything since. Measured 2026-09-24: 3 such recycles cost up
  to 63 min of a lead still alive. Commits after a wedge = alive, do not
  recycle. No commits is NOT evidence of death.
- `fleet provision|recycle <id> --fresh-session` — session claude cannot
  resume (corrupt, oversize, exits on `--continue`). One bring-up skips
  adopt + `--continue`. Old session moved aside to
  `~/.claude/projects/fleet-aside-*`, never deleted, shipped with next
  snapshot. Row's error line names where (#28).
  503 `the Durable Object did not answer` = every repair verb dead the same
  way. Retry cannot help — unless it says `retryable=true`: then one retry
  may land. Same failure again → watch CHECKED in `fleet ls`; wait (~20 min,
  2026-09-24).
  503 `the Durable Object reset mid-call` (`durableObjectReset=true`) = DO WAS
  reached, then reset (container link dropped, or a deploy). One retry
  reaches a fresh instance. Same failure again → wait, watch CHECKED.
- `fleet provision <id>` — heals a half-built studio on its existing
  container. Does NOT pick up a new image.
- `fleet destroy <id> [--force] [--discard-unsynced]` — rescues first (like
  recycle), then stops the container AND tears down its
  local Orca worktree and attach terminal (board #57). **It does NOT remove
  the registry entry.** The studio stays in `fleet ls` as `stopped`, and a
  following `fleet spawn <role>` answers **409 "studio exists"**. The way back
  is `fleet provision <id>` or `fleet recycle <id>` on that same id, or `ff`,
  which provisions the existing entry. "Stop for good" means stops, not
  disappears. A running container that cannot answer the 8s probe cannot be
  rescued: destroy REFUSES (409) and names the last-sync age, like recycle.
  `--discard-unsynced` proceeds anyway. A container still booting is waited
  out first; one not running is destroyed with no exec at all. See "Tearing
  a studio all the way down", below, for the full sequence and the `--force`
  caveat.

### Tearing a studio all the way down

Board #57, fixed 2026-09-23: `fleet destroy` used to stop only the container.
The local Orca worktree and attach terminal `ensureStudioWorkspace` creates on
every spawn/provision/recycle survived the stop, leaving a dead
`root@cloudchamber:/workspace#` shell and a sidebar row visually identical to
a live studio — two coordinators produced exactly that by following this
skill's own (then-unscoped) "Do not delete it" line, below. `fleet destroy`
now does the whole teardown itself: stop the container, close the attach
terminal, salvage any `.context/` evidence, remove the worktree. The
full sequence, end to end:

1. `fleet task state <n> completed` — mark the board task done first.
2. `fleet destroy <id>`. The refusal guard reads BOARD state (#55): a task
   in `completed`/`failed`/`canceled` never blocks, even while its issue is
   still open. A 409 names each blocking task: cancel it
   (`fleet task state <n> canceled`), reassign it (`fleet task assign <n>
   <role>`), or pass `--force`. A task named as having drifted labels (not
   exactly one state label) needs its labels fixed by hand on GitHub.
   `--force` skips the open-task check entirely, AND (#104) also skips the
   rescue on a wedged container — it counts as `--discard-unsynced`. Know both
   before passing it on a studio you have not actually confirmed is done.
3. Read destroy's stderr, then confirm with `fleet ls` (ROW column, below)
   that the row reads `none`. Destroy's Orca cleanup is best-effort — it can
   degrade (Orca absent, wedged, or erroring) without destroy itself failing.
   `could not verify teardown: …` means absence is NOT proven: **close any
   `fleet attach` terminal for that studio by hand — a live attach reconnects
   and boots a new billing container** (live incident 2026-09-24, #123).
   Finish by hand: `orca terminal close --terminal <handle>`, then
   `orca worktree rm --worktree "path:<abs>"`.

**A destroy that times out is not a destroy that failed (#203).** The Worker's
destroy can outrun this side's 300s request deadline (boot wait + probe +
sync, and rescue-push/harvest are 300s each). When the request does not come
back, `fleet destroy` now polls `GET /studio/:id/status` 6 times, 10s apart,
and says what it read: `stopped` → it prints the row, says the destroy
SUCCEEDED and runs the Orca teardown; still not stopped → "destroy still
running, check fleet ls", **no teardown line**; status unreachable → the
outcome is UNKNOWN. It never reports `failed` for an outcome it could not
read — measured 2026-09-24, a destroy printed "The operation timed out." for a
studio that was already stopped with its worktree gone. On the two non-stopped
readings, exit is non-zero and nothing was torn down locally: re-run
`fleet destroy <id>` once `fleet ls` shows `stopped`.

**Teardown by PATH, never by name.** `orca worktree rm --worktree "name:<x>"`
also matches branch names — it has already destroyed a live agent mid-task in
a real incident. Always resolve the worktree's absolute path first
(`orca worktree list --json`) and remove it as `"path:<abs>"`.

**`.context/` is gitignored evidence — never delete it blind.** It can hold
screenshots and working notes nothing else preserves (a real incident found
11 screenshots and 24 context files across two studio worktrees that a blind
`rm` would have destroyed). `fleet destroy`'s own teardown salvages it first,
to `~/fleet-teardown-salvage/<studio-id>-<timestamp>/`, and says so on
stderr; if doing this by hand, copy `.context/` out before removing the
worktree, or name file-by-file what you are about to lose.

**`fleet ls` ROW column — this machine's Orca row per studio (#55, #57 item 4).**
Running studio (or `stopped` whose container still runs):
- `ok` — row + a healthy `fleet attach` terminal (connected, not orphaned, writable).
- `attach DEAD` — attach terminal exists but orphaned/unwritable/disconnected. `fleet tabs` replaces it.
- `NO attach` — row, no attach terminal. `fleet tabs` creates one.
- `NO row` — invisible studio. `fleet tabs` creates the row.
- `? no id` — Orca listed the row without an id. Cannot judge it.
- `?` on every row — no verdict at all, NOT a missing row. The footer line
  `ROW ?: <why>` says which: orca binary not found, not running under Orca,
  or Orca did not answer (list failed, timed out after 3s, or truncated).
  Re-run `fleet ls` before concluding anything (#299).

`fleet tabs` skips every `stopped` studio. For `stopped (container RUNNING …
billing)` (#95), the ROW verdict is a warning, not a tabs job: the container
is the problem. Never remove that row — it is the only local sign of the bill.

**Sending a key to a blocked lead's Orca terminal (#220).** Get its attach
handle with `fleet attach <id> --print-handle` (prints the handle, or `none`)
— never with `fleet tabs`, which RECONCILES (creates/closes/renames
terminals) rather than merely reading, and stacks an extra attach client as a
side effect just to answer what should be a read.

**`fleet tabs` is scoped to ONE repo by default (#216) — it is not a
fleet-wide command anymore.** Bare `fleet tabs` reconciles the studios of the
repo you are standing in (same cwd-detected repo `fleet spawn` already
resolves); `--repo <owner/repo>` names a different one; `--all` opts into
every repo in the fleet, explicitly — the old, unscoped default is now
something you have to ask for. Before touching anything it prints one line
per studio it will touch (`open` / `has one` / `skipped: <reason>`), and an
`--all` run without `--yes` asks to confirm first. A folder that names no
repo refuses rather than silently falling back to `--all` — run it from
inside a repo, or pass `--repo`/`--all` explicitly.

Stopped studio: `none` — teardown finished. `STALE row` — row survived
teardown; finish it by hand (step 3). `?` — could not tell. Stdout footer
`ROW ?: <why>` names it: orca binary not found, not under Orca, or Orca did
not answer (failed, 3s timeout, truncated list). `? no id` — Orca listed the
row without an id. `?` is never proof of absence.

## Is it actually working?

Container state is not work. **After ANY spawn, prove the studio is doing
something** — a studio can sit `running` with READY `?` for 20+ minutes having
spent zero tokens, burning container money.

What each signal can and cannot tell you, measured 2026-09-16:

| signal | tells you | cannot tell you |
|---|---|---|
| `STATE` | the container is up | anything about the agent |
| `READY` | harness intact / agent present | whether it is working |
| `BURN` `<n>o/5h:<n>` | **zero since spawn = nothing ever happened** | whether a lead mid-task is thinking or stopped — it counts OUTPUT tokens only, and freezes during reading and reasoning |
| screen footer | **the truth** | — |

BURN is the right first check after a spawn and the wrong check an hour later.
A lead reasoning for four minutes and a lead stopped for twenty-five show the
same frozen number. Neither STATE nor LAST ACTIVITY separates them either.

**The one reliable signal is the lead's screen:**

```
orca terminal read --terminal <handle> --screen | tail -8
```

- footer shows `esc to interrupt` → a turn is running
- footer shows only `⏵⏵ bypass permissions on … ← for agents` → idle at the prompt

Before trusting that read, check the tmux window in the status bar:
`[studio] 0:claude*` means you are looking at the agent; `1:shell*` means you
are looking at a bash prompt and every conclusion is wrong. Bring-up returns the
session to claude (#314), but an operator or probe can still leave it on shell.
`Ctrl-b 0` returns to claude.

**Never send to a lead on `1:shell*`.** Keystrokes go to the ACTIVE window: a
message meant for the lead runs as a bash command in the container (measured
2026-09-25). Before any `orca terminal send`, read the status bar; on
`1:shell*`, send `Ctrl-b 0` first and read again.

If the render is corrupted, a wrapped line can split `esc to interrupt` in
half. Flatten newlines before matching.

**A lead stops at the end of its turn, and nothing wakes it.** Finish a task,
post the envelope, write a summary, sit at an empty prompt — like any Claude
session. Queued tasks on the board do not start by themselves. Filing a task
does not start one. To give an idle lead its next task, type to it, then
confirm by the screen, never by the send's return value
(`orca terminal send` reports `accepted` with `observation: "unsupported"`).
A send can also HANG before Enter and leave your whole message sitting in the
lead's input box as a `draft` — the lead idles, and it looks sent. Measured
2026-09-18. Read `orca terminal read --screen --json` → `result.terminal.draft`:
non-empty means NOT submitted; send a bare Enter (`--text "" --enter`) and
re-check. TWO strings there are UI hints, not your text — treat as empty:
`Press up to edit queued messages` (your message WAS accepted, queued behind a
running turn) and `Image in clipboard · cmd+v to paste`. A detector that flags
those cries wolf on every queued send. The docs say it plainly: draft is never a submitted instruction.

## Traps that make a healthy fleet look broken

**Merged is not served.** The fleet reads its org chart, roles and skills
from `main` of the blueprint repo. A PR merged to `staging` changes nothing
until it is promoted. Read the branch and the deployed state, never the
issue.

**Deploy is not rollout.** `wrangler deploy` diffs the image DIGEST. Output
saying `no changes fleetflare-studiodo` means the image did not rebuild and
your container change is not live. And even after a real push, the first
recycle often lands on the old image — poll on script CONTENT inside the
container, never on a route's verdict.

**A studio can look alive and be bare.** Container running, claude gone,
harness missing. `fleet ls`'s READY column and `GET /studio/:id/provisioned`
tell the truth; the STATE column does not.

**`fleet` inside a container is a different CLI.** In-container it is
`studio-fleet`, a much smaller surface. `fleet attach` there does nothing.

**Every running studio gets a local worktree and a sidebar row — on purpose — when running under Orca.**
Orca is optional (#334): with no `orca` binary, `fleet`/`ff` print one line
(`orca not found on PATH … attach from any terminal with: fleet attach <id>`)
and skip the row; inside a studio container they stay quiet.
`fleet spawn` / `provision` / `recycle` / `ff` create an Orca worktree named
`studio-<id>` with an attach terminal in it (`ensureStudioWorkspace`, #157).
That is the visibility guarantee: nothing spends money in the cloud where the
operator cannot see it. **Do not delete it while the studio is running** — it
silently does nothing if Orca does not know the repo (`orca repo add <path>`
first), so a still-live studio would go invisible with no error either way.
Once the studio is actually destroyed, the worktree and terminal are exactly
what "Tearing a studio all the way down" (above) exists to remove — `fleet
destroy` now does that itself; do not hand-apply this "do not delete" rule to
a studio already torn down.

A **second, empty tab** in that worktree is a defect, not the feature. Close it.
It also matters beyond clutter: two tmux clients on one session make
`window-size latest` size the pane to whichever attached last, and the size
stays stuck after that client leaves — the source of the corrupted render and
the blank band at the right and bottom of the terminal. One attached client per
studio.

**A deploy kills every running studio.** `wrangler.jsonc` sets
`rollout_step_percentage: 100`, so a deploy that changes the studio image
replaces EVERY running container at once. Measured 2026-09-18: a deploy killed a
lead two minutes into a task — twice: once at deploy time, and again ~12
minutes later when the rollout CONVERGED and replaced a container that a
recycle had booted on the old image. **A rollout replacement does NOT run the
fleet's rescue-push** — only `fleet recycle` / `destroy` do. Unpushed work in a
rolled container is gone. **`bun run deploy` runs `fleet rescue-all`
itself** (issue #251; gate built into `scripts/deploy.sh` by issue #20) and
refuses on `pre-deploy gate UNSAFE`. Never call a bare `wrangler deploy`: it
skips the gate. `--allow-unrescued` overrides, loudly; a first deploy (no
Worker, no creds) needs it. Gate also refuses when wrangler's target Worker
(config + `--env`/`CLOUDFLARE_ENV` + `--name`) is not the fleet
`~/.fleet/credentials` names (issue #36) — else it rescues the wrong fleet
and says SAFE. Deploying another fleet: point credentials at it first.
rescue-all commits and pushes
every RUNNING AND DEGRADED studio's uncommitted work (the main checkout AND
every member git worktree, each independently, each to its own
`fleet/rescue/...` ref), plus every local branch not checked out anywhere and
every stash entry holding unpushed work, repo-wide — a member subagent's own
stash or an abandoned branch is never invisible. A push rejected non-fast-
forward (a branch moved on origin) retries once to a freshly generated ref
before it counts as a failure. Degraded is included on purpose: a failed
refresh, a failed restart, or a failover still leaves a container running
that can hold real work — only the ROLLOUT that eventually replaces it skips
rescue entirely, which is the whole reason this command exists. A stopped or
provisioning studio is never exec'd against and is printed as `skipped <id>
(<state>)`; a studio whose registry state looked running/degraded but whose
container itself answers "not running" (stale registry) is printed `skipped
<id>: container not running` — neither counts as a failure. It exits
non-zero ONLY when a studio's rescue attempt genuinely failed (a rejected
push, a lock file, a hook), and its last line says `pre-deploy gate SAFE` or
`... attempted studios not rescued (<f> push FAILED, <t> TIMED OUT) --
pre-deploy gate UNSAFE; do NOT deploy`. Also check
`fleet ls` for working studios and deploy between tasks when you can — and
after a deploy, expect one more container replacement before the image is
stable (run `fleet rescue-all` again once it lands, for the same reason).

**And the first recycle after a deploy often boots the OLD image anyway.**
Measured 2026-09-18: deploy pushed the new image (3 pushes in the wrangler log),
recycle booted a container whose `/opt/fleet/studio-bringup.sh` lacked the new
line. Open platform bug cloudflare/containers#233. Verify by grepping a
known-new line INSIDE the container, never by a route or version column. Apply
the change at runtime meanwhile and let convergence catch up.

**A rescue branch is invisible to the next container.** Studio clones are
SHALLOW and SINGLE-BRANCH — `git log` inside shows `(grafted, origin/main)` and
`git branch -a` lists only `main`. The rescue-push lands on a branch the next
lead cannot see. Measured 2026-09-18: a lead told to resume from
`fix/orca-terminal-idempotency` searched, found nothing, and correctly refused
to act on "a false premise". To resume, tell the lead to check and fetch it
itself — never to trust you:
`git ls-remote origin refs/heads/<branch>` (expect the sha), then
`git fetch origin <branch>:<branch> && git checkout <branch>`.

**The `bun-test` lane used to kill the studio running it** — fixed in
`3072ae6` (2026-09-18). `test/bun/wake-cmd.test.ts` ran `tmux kill-server`
against the REAL server whenever `TMUX` was set. A branch older than `3072ae6`
still carries it: merge `origin/main` first, then both lanes are safe in a studio.

**A studio cannot safely build itself.** A task that EXECUTES
`studio-bringup.sh`, or the shell it emits, inside the studio that script built
runs in the same place claude lives — and can kill it. A lead did exactly this
and died mid-task with 534 lines of unpushed work. Tasks that touch bring-up may
READ the shell as text; executing it belongs to the CI `bun-test` lane or the
Mac. Before any `recycle` of a `bare` studio, push its work from the shell
window first — `recycle` destroys the filesystem.

## CI on fleetflare is a commit status

GitHub Actions is disabled on `rafarc21/fleetflare` (#267, no CI spend). The
operator's Mac runs the same lanes and posts commit statuses on the PR head:
`local-ci/fleet-check` (tsc, vitest, Linux bun-test) and `local-ci/english`.
Read them from a studio or the Mac:

```bash
gh api repos/rafarc21/fleetflare/commits/<sha>/status \
  --jq '.statuses[] | select(.context|startswith("local-ci/")) | "\(.context) \(.state) \(.description)"'
```

No `local-ci/*` status = not run yet (Mac asleep, daemon off), never green.
Run one by hand on the Mac: `apps/fleet/scripts/localci/localci.sh <pr>`.
`gh pr checks` shows them too. Never re-enable Actions to get a green.

## Claude accounts (#271)

- **One account per repo, fixed.** `CLAUDE_ACCOUNT_BY_REPO` (Worker var, JSON,
  e.g. `{"demosite-life": 2}`) sends a repo's studios to
  `CLAUDE_CODE_OAUTH_TOKEN_<n>`. Unmapped repos use the first SET account in slot order. ACCOUNT in
  `fleet ls` shows the secret NAME, with `CLAUDE_ACCOUNT_<n>_LABEL` in front
  when set: `second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2)`.
- **Adding account 2 is the operator's step, in his terminal:** `claude setup-token`,
  then `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2`. No agent runs it and no
  token goes in a brief, log, PR or transcript.
- **Mapped slot with no secret:** the studio refuses to launch. Its row says
  `mapped to CLAUDE_CODE_OAUTH_TOKEN_<n> … refusing to launch`. Set the secret;
  do not unmap to force it through.
- **Auto-failover is OFF** unless `FLEET_AUTO_FAILOVER=on`. Off, a limit reads
  `degraded` with `Auto-failover is off … no switch attempted`, one card, no
  switch. Wait for the reset, or remap and recycle.
- **Switching a studio's account needs a new container.** After a map change,
  `fleet recycle <id>` between tasks, never mid-task.

## Heavy gate budget

One heavy gate at a time — full test suite, `vite build`, repo-wide
`tsc`/typecheck, e2e, pre-push hooks. **The verification a task demands
counts toward the gate budget, not just the diff.** A RED/GREEN mutation test of
a heavy check runs that check twice. Run such verification one step at a
time, never in parallel, never alongside another gate. A task author names
heavy verification in the task's Boundaries (e.g. "verifying X runs
`<heavy gate>` twice").

Measured 2026-09-24 18:45Z: a one-line task mutation-tested one repo
invariant; that invariant file runs two full vite builds, so RED+GREEN =
FOUR builds in one container. Hit the 11.65 GiB memory ceiling and wedged.
Recovered only by `recycle --discard-unsynced`, losing 22 min of
conversation; the 20 pushed commits survived on origin. A one-line diff is
not a cheap task — price the verification.

## Repository language

All repository content is English — code, comments, docs, board issues, PR
titles and bodies, commit messages. The project is read by people who do not
share the operator's first language. The operator's own conversation language
is a separate matter and not governed by this. NOT UX copy: product copy an
end user reads stays in the product's own language. Write a brief to a studio
in English too: its words land in issues and commits. In rafarc21/fleetflare,
CI enforces it (`apps/fleet/scripts/english-check.ts`).

## What not to do

- Do not edit board state with `gh issue edit` / `close` / label. The Worker
  is the single writer of task state; agents that write labels create the
  drift where a merged PR leaves an issue claiming in-progress. Comment
  freely — that is how a studio reports.
- Prefer `fleet task new` over raw `gh issue create` for fleet work. A
  hand-filed issue lands with no state and no owner: backlog in
  `fleet task ls`. It is not stuck. Adopt it:
  `fleet task assign <n> <role>` (e.g. `fleet task assign 42 web-studio`).
  That sets `submitted`, labels the studio and wakes it. `ff <role> <n>`
  adopts and attaches in one step.
- Do not spawn a studio to do something you could do in 30 seconds here.
- Do not report a studio as working from `fleet ls` alone. Check the screen.
- Do not churn a provisioning studio. Five minutes.

These held up in the field and are worth keeping exactly as they are: the board
as the single source of truth for task state, never hand-editing that state,
`fleet task new` refusing a task without all four brief sections, and
merged-is-not-served. All four prevented real mistakes on 2026-09-16.
