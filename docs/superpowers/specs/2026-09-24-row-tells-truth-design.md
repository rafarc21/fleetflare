# Row tells the truth — #85, heartbeat v1 (container + session layers)

Date 2026-09-24. Direction approved by the operator in chat, same day ("Go ahead").
Measurements that arrived after approval (wedged studio, stale restore source)
sharpened PR1; marked **[post-approval]** for review.

Issue: https://github.com/rafarc21/fleetflare/issues/85
Evidence:
- https://github.com/rafarc21/fleetflare/issues/85#issuecomment-5812759438 (BETA coordinator)
- https://github.com/rafarc21/fleetflare/issues/85#issuecomment-5813083675 (maestro)

## Problem

`fleet ls` says `provisioned` while the thing that matters is gone. Four
shapes, all measured 2026-09-24:

1. **Stale after replacement.** Rollout replaced containers 10:45:46Z. Row
   kept the verdict from before. ~10:52Z the BETA coordinator read 3 rows
   `provisioned`; 2 were bare (`checkout: MISSING`, `pane: bash`). Ruling
   posted and board task flipped `working` into an empty container.
2. **Wedged.** `demosite-life--web-studio`: exec plane dead, lead still
   working. DO alarm stopped firing (zero alarm events 11:05–11:11Z; peers
   had 11–13). Row read `running / provisioned` throughout; only CHECKED aged
   (1m → 14m). Needs recycle, not provision.
3. **Stale restore source. [post-approval]** Same studio. R2 `latest` froze
   10:10:00Z. Recycle 11:11:06Z: probe failed → rescue sync skipped →
   restored the 10:10 snapshot. Session faa165b4 has zero entries
   10:08:55–11:11:06. ~63 min of conversation lost. Nothing said so.
4. **Blank lead.** Before #89 every replaced studio started a new session and
   the next sync overwrote `latest`. #89 closed the main path: 5/5
   replacements after 10:45:46Z resumed the same session. Code-level silent
   paths remain: restore throws; bring-up rejects the staged restore; checkout
   missing → claude starts in `/container-server` (wrong project key);
   restore lands under an already-running blank lead. And nothing records
   resumed vs fresh:
   - `runSessionRestore`'s (provision.ts) own result discarded by both its
     callers, `runProvision` and `runRestart` (provision.ts);
   - restore-success line goes to stdout nobody reads (`studio-bringup.sh:578`);
   - `step-ok session-restore` is written unconditionally.

5. **DO-side failure. [post-approval]** `demosite-life--pilot` from 11:20Z,
   healthy 15 min before:
   - `fleet inspect` → `the Durable Object call failed before the container
     was read: Network connection lost.`
   - `fleet recycle` fails with the same error. The repair verb inherits the
     fault.
   - Row `running / provisioned` throughout, over 5 attempts across 10 min.
   - Inspect's two error strings (#92) are what told the operator whether a
     recycle would help. Keep "only the container side failed" verbatim.
     #96 replaced the DO-side one: "failed before the container was read"
     over-claimed (`Network connection lost` also comes from DO→container
     link). Now: "Worker->DO call failed; the container may or may not have
     been reached". Wedged line also appends recycle price (snapshot age).

Common shape: a signal authoritative about its own layer while the layer that
matters is gone. Two competent readers got the same row backwards the same
afternoon.

## Goal

No row says `provisioned`, or implies a live lead with its memory, when the
fleet has evidence otherwise, or has NO recent evidence at all. The row names
the shape and its age:
- `replaced`: within one 30s ship tick;
- `unreachable`: ~90s — restored (board issue #183, landed) via a time-based
  rule: ≥2 consecutive failed ship ticks AND ≥90s elapsed since the last
  known-good tick (`Observed.lastShipOkAt`), computed by `isUnreachable`
  (observed.ts) and used by the render gate (`readyOverride`/
  `formatUnreachableLine`, cli/readiness-format.ts). Review round 7
  simplification: the DO's own out-of-cadence write-trigger
  (`runShipTickWithObservation`, do.ts) does NOT call `isUnreachable` — it is
  a separate, simpler mandatory checkpoint (`execFailures === 2`) that was
  provably equivalent to the earlier two-call composition it replaced (see
  do.ts's own doc comment on that checkpoint). Tick cadence is unchanged;
- everything else: within two check intervals (660s).

**History (superseded by board issue #183 above):** the fixed
`execFailures >= 3` render gate this PR (#85 PR1) originally shipped — three
CONSECUTIVE ship-tick failures, regardless of how long each one actually
took — measured (issue #85 review round 6) at 89s / 120s / 141s across three
real failure scenarios, plus a 0-30s phase depending on where in the alarm's
own schedule the failing tick lands, and up to ~5 minutes worst case once
`container.alarm`'s own serial execution of other due callbacks queues ahead
of it. Accepted 2026-09-24 (issue #85 review round 5, re-affirmed round 6)
over shortening the reschedule backoff, which would probe an already-wedged
container more often instead of detecting it faster, with the eventual ~90s
goal tracked separately as board issue #183 — now landed, describing the
count-based rule these numbers were measured against, not current behavior.

**Review round 2 update (supersedes the round-1 estimate below):** the
board issue #183 fix's own first landing (round 1) measured its worked
timing against a single failure mode — a fully-hung exec that only ever
resolves via `runShipTickWithObservation`'s own looser
`SHIP_EXEC_DEADLINE_MS` backstop — giving 60s (1 failure, not yet
unreachable) / 120s (2 failures, unreachable) end to end. That estimate
missed two other failure shapes review round 2 found and fixed (BLOCKER 1,
MUST-FIX 2): a fast-failing exec that rejects near-instantly or resolves via
#110's own tighter exec-level deadline rather than this file's backstop, and
the out-of-cadence D1-write gap such a streak opens up before the render
side ever sees a fresh row. Measured under the corrected (round-2) rule,
elapsed from the last good ship — or, absent one (a studio wedged from its
very first tick), from the first failure (`Observed.unreachableSince`,
MUST-FIX 2's anchor fallback) — instead: the actual numbers for each of
these failure shapes (dead from deploy, killed/fast-failing exec, a late
tick, and the worst-case sync-tick hold), plus the further
`lastShipOkAt` re-anchoring fix layered on top of them, are folded into the
single measured table below rather than restated here, so there is one set
of numbers instead of two that can silently drift apart.

The 60s/120s round-1 figure is not wrong for the ONE scenario it modeled
(the fully-hung exec) — it simply was not the complete picture: round 2's
own BLOCKER 1 fix (forcing the D1 write the moment `execFailures` reaches 2,
regardless of whether `isUnreachable` itself is already true at that exact
instant) is what keeps the fast-fail/D1-write-gap case above from silently
drifting past its own already-generous worst case before a `fleet ls` row
ever reflects it.

**Board issue #183, `lastShipOkAt` re-anchoring on answered bring-up/failover
(additional layer, on top of the round-2 rule described above — not a
replacement):** a successful bring-up (`recordBringupObservation`,
provision.ts) or a successful failover (the correction #13 patch,
failover.ts) both reset `execFailures`/`unreachableSince` on an answered
observation exec, but used to leave `lastShipOkAt` stale — never
re-anchored — so the elapsed-time clock measured from an older, wrong
instant. Measured (simulated clock, real `sbExec` + ship tick + D1 +
`readyOverride`; seconds from last good ship; typical/worst over a
sync-tick phase 0-299s; "head" = this branch post-fix, "main" = pre-this-PR
current main):

| scenario | head (typical/worst) | main (typical/worst) |
|---|---|---|
| dead plane (hang, then SessionBusy) | 90/213 | 117/243 |
| killed (exit 124) | 101/581 | 152/631 |
| exec answers 29s late | 114/258 | 171/315 |
| instant reject | 90/90 | 90/90 |
| after bring-up (post this fix) | 90 (all modes) | — |

Worst case overall = a 480-second `syncSession` tick deadline holding the
alarm, plus ~100s more on top.

Success: each shape above, replayed as a test fixture, renders its own word.

## Principles

1. **Every signal carries its observation time. Reader computes age.** A
   verdict older than its refresh budget renders STALE with its age, never its
   stored value. A frozen writer (stuck alarm, wedged exec) then shows up by
   construction.
2. **Observation-only.** No new actor. Nothing here heals, restarts, wakes or
   recycles. #71's heal unchanged. Guidance text for humans is fine
   (`→ recycle`). (Exception: PR4b, below — a Worker-initiated wake after a
   detected replacement. Composing and delivering a re-brief after that
   replacement is the entire point of #107, so it cannot be observation-only
   by construction; it is the one deliberate actor this spec authorizes.)
3. **Worker + CLI only.** Nothing under `apps/fleet/container/`. Image digest
   unchanged → deploy replaces no container. Deploy log must print
   `Image already exists remotely, skipping push`.
4. **Own storage.** New facts live in their own DO key and their own optional
   field on the D1 row. Never in `status.error`: `isProvisioned`
   (`src/studio/ff.ts`) reads any non-null error as not provisioned, `ff`
   re-provisions, and a successful provision resets `error`
   (`runProvision`, provision.ts), erasing the warning. Never inside the
   `status` read-exec-write cycle either (stale-overwrite race — the ship
   tick's own `runShipTickWithObservation`, do.ts).
5. **Unknown is neither good nor bad.** No evidence renders `?` plus a
   reason, same as today's `formatReady`.

## What the row says

### READY: overrides, state `running` only, first match wins

| READY renders | when | operator action |
|---|---|---|
| `replaced 40s ago — not brought up` | ship tick found no incarnation token (below) | wait for heal, or provision |
| `unreachable 6m — wedged? → recycle` | ≥2 consecutive ship-tick exec failures AND ≥90s since the last known-good tick (board issue #183 — supersedes PR1's original ≥3-consecutive-failures-alone gate, see the Goal section above). The DO is alive and counting, so the fault is on the container side | recycle |
| `unverified 14m — checks not completing → fleet inspect` | readiness `checkedAt` older than `2 × SYNC_SESSION_SECONDS + 60s` (660s). Computed in the CLI, so it also catches a DO that can write nothing: a frozen alarm or a failing DO (shape 5) | `fleet inspect` first: it names the failing side. Recycle only if the container side failed; recycle cannot fix a failing DO |
| existing token | otherwise | — |

The CLI applies overrides only to `state: running`. While the operation lock
is held (#86/#87, `state: provisioning`) the DO also skips replaced and
unreachable detection, because a bring-up in flight has no token yet. A
stopped studio renders exactly as today.

### SESSION: new column

| SESSION renders | meaning |
|---|---|
| `resumed · snap 3m` | last bring-up launched claude with `--continue` in `/workspace/<repo>`. Snapshot fresh |
| `resumed · from snap 61m old` | resumed, but the restored snapshot was 61m old at restore time. **[post-approval]** Up to 61m of conversation may be gone |
| `fresh · snap 3m` | launched without `--continue`, and no prior history. New studio. Quiet |
| `LOST · had 412 turns` | launched without `--continue`, or cwd is not `/workspace/<repo>`, while prior history exists. Loud |
| `?` | verdict not yet determined (pre-feature row, or the exec failed) |

Exact grammar:

    <verdict>[ · had <n> turns][ · from snap <age> old] · snap <age>[ STALE]

- `had <n> turns`: only with `LOST`.
- `from snap <age> old`: only when the restored snapshot was older than 660s
  at restore time. This is the age at RESTORE time.
- `snap <age>`: always shown. It is the age NOW of the last successful
  session upload; `snap ?` until the first upload after deploy. Past 660s
  while running it renders `STALE`. That would have flagged the wedged
  studio about 10 minutes after its snapshots stopped. **[post-approval]**

`LAST ACTIVITY` keeps its label through PR1. The label is deliberate
(`cli/fleet.ts:196`). PR3 revisits it: once a real `ACTIVITY` column exists
beside it, the old one is renamed `REFRESHED`, which is what it has always
been.

### ACTIVITY: the PR3 column

Whether the lead is WORKING, IDLE since t, WAITING ON MEMBERS, or on a LIMIT
— and `?` whenever the screen does not say. Designed in full under PR3 below.

## PR1 — READY tells the truth

### Signals

1. **Incarnation token.** At the end of every successful bring-up (provision,
   restart, heal, recycle, failover relaunch) the Worker writes a random id to
   `/workspace/.fleet/incarnation` and stores the same id in the DO. A
   replaced (or slept, disk-wiped) container has no file.
   - The existing 30s ship tick appends `cat /workspace/.fleet/incarnation` to
     its single exec (`transcript.ts` `shipTickCmd`, ~275-292). No extra exec.
   - Missing → set `replacedAt` once. Equal → clear it. Different → replaced,
     reason `foreign incarnation`.
   - **Adoption, not an alarm.** The DO stores no incarnation yet (a
     pre-feature studio, or the first tick after this deploy): the tick
     writes a token and stores it. It also computes a first session verdict
     with `via: "adopted"`. Without this, the deploy itself would mark every
     running studio `replaced`.
2. **Reachability.** Ship-tick exec runs under a deadline (originally the
   #92 inspect deadline, 15s — since corrected, issue #85 review round 4,
   NIT 16(b): that was strictly SHORTER than the ship exec's own
   already-established per-exec deadline (#110's `EXEC_CLASSES.ship` + slack,
   27s), which raced a merely-slow-but-alive tick against the wrong timer and
   flagged it unreachable early. Production now defaults to
   `SHIP_EXEC_DEADLINE_MS` (~30s, `do.ts`) instead, looser than #110's own
   total exec-level deadline so that already-tested mechanism is what
   actually fires). A timeout or failure bumps `execFailures`; `unreachableSince`
   is set at the FIRST failure of the streak (execFailures 0->1), not at any
   count threshold. Board issue #183 — the actual "unreachable" determination
   (and the D1-write / render-crossing trigger) also requires
   `now - lastShipOkAt >= 90s` (`isUnreachable`, observed.ts), not
   `execFailures` alone. First success resets `execFailures`, clears
   `unreachableSince`, and stamps `lastShipOkAt`. The deadline keeps the
   detector itself from hanging; it changes nothing the tick ships.

   **History (superseded by board issue #183 above):** this originally read
   "At 3, set `unreachableSince` = first failure time" — a fixed
   `execFailures >= 3` count-only gate with no time component. See the Goal
   section's own History note above for the measured drift that motivated
   the change.
3. **Session verdict.** After every bring-up the Worker reads the LIVE lead
   process, not bring-up's intent. The lead is the claude process that is a
   direct child of the `studio:claude` pane's shell
   (`tmux display -p -t studio:claude '#{pane_pid}'`). Member `claude -p`
   processes sit deeper in the tree and must not match.
   - argv contains `--continue`? (`/proc/<pid>/cmdline`)
   - cwd = `/workspace/<repo-segment>`? (`/proc/<pid>/cwd`)
   - Inputs kept, no longer discarded: `runSessionRestore` result (`restore`
     or `skip`, plus why: no snapshot / container already has projects /
     threw).
   - Prior history = `burn.turns > 0` at bring-up (lifetime count, never
     resets) OR the restore found a snapshot in R2.
   - Snapshot age at restore = restore time − time of the last successful
     upload. Source: DO-recorded `lastSnapshotAt` (below), falling back to
     the R2 object's `uploaded`.
   - Verdict: `resumed` (continue + right cwd) | `fresh` (no continue, no
     history) | `lost` (no continue or wrong cwd, history exists) |
     `unknown` (read failed).
4. **Snapshot freshness.** Set `lastSnapshotAt` when `syncSessionTick`'s R2
   put succeeds (`session-sync.ts:394`).

### Storage

One new DO key, `observed`:

```ts
type Observed = {
  incarnation: string | null;
  replacedAt: string | null;
  execFailures: number;
  unreachableSince: string | null;
  lastShipOkAt: string | null;
  lastSnapshotAt: string | null;
  session: {
    verdict: "resumed" | "fresh" | "lost" | "unknown";
    at: string;
    via: "provision" | "restart" | "heal" | "recycle" | "failover" | "adopted";
    restore: "restored" | "skip:no-snapshot" | "skip:has-projects" | "failed" | "not-attempted";
    snapshotAgeS: number | null;
    turnsBefore: number;
    reason: string | null; // e.g. "cwd /container-server", "no --continue"
  } | null;
};
```

D1 mirror: optional `observed?` on the studio row (the registry stores the
JSON blob, no migration; add a cleaner beside `cleanReadiness`, redact
container text). Writes happen:
- on transition only (replaced set/cleared, unreachable set/cleared);
- at bring-up (session verdict);
- `lastSnapshotAt` rides the existing 300s burn mirror (`recordSnapshotOnSuccess`,
  do.ts), so it adds no write.

**Correction (board issue #183, investigated while adding `lastShipOkAt`
below):** the "rides the existing write, adds no write" claim above does not
actually hold for the DO-storage (`observed`) write, only for the D1 mirror
cadence — `recordSnapshotOnSuccess` (do.ts) issues its OWN separate
`mergeObserved(observedStorage, { lastSnapshotAt: now })` call on a
successful sync tick, distinct from whatever write `syncSessionTick` itself
performs. There is no genuine zero-added-DO-write precedent to follow here;
issue #183's own `lastShipOkAt` field (below) accepts the same one-extra-
`mergeObserved`-call cost on every successful ship tick instead, documented
at its own write site (do.ts's `runShipTickWithObservation`).

Issue #183 adds one more field to `Observed`: `lastShipOkAt: string | null`
— the last time a ship tick actually succeeded, updated on every success
(not merely a state change). See `Observed.lastShipOkAt`'s own doc comment
(observed.ts) for why this is NOT the same thing as `unreachableSince`
above.

### Rendering

- A pure `readiness-format.ts` gains `readyOverride(status, now)` and
  `formatSession(status, now)`, tested like `test/cli.fleet.test.ts:70-131`.
- `formatTable` adds the SESSION column.
- Update `READY_CAVEAT` and `fleet help` text.
- `fleet inspect` prints the stored verdict lines (zero container cost). Its
  existing single exec adds `incarnation: present|MISSING` and the last 15
  lines of `/workspace/.fleet/bringup.log`, which inspect does not read today.

### Error handling

- Every new read tolerates exec failure. It yields `unknown` / `?` plus a
  reason and never throws into the alarm.
- Detector order inside the cycle is unchanged.
- The token write failing does not fail bring-up. It logs, the verdict
  reads `?`, and the ship tick then reports `replaced`. Loud, never silent.

### Tests (TDD, failing first)

Fixtures replay today's shapes:

| # | fixture | expect |
|---|---|---|
| T1 | `replacedAt` 6m ago, readiness still `provisioned` from before | READY `replaced 6m ago — not brought up` |
| T1b | first tick after deploy, no stored incarnation | token adopted, no `replaced`, verdict `via: adopted` |
| T2 | 3 ship-tick timeouts, `lastShipOkAt` 7m ago (past board issue #183's 90s threshold) | READY `unreachable …` |
| T3 | `checkedAt` 14m old, nothing else changed (frozen alarm) | READY `unverified 14m …` |
| T4 | recycle restored snapshot uploaded 61m earlier | SESSION `resumed · from snap 61m old` |
| T5 | fresh launch, `turnsBefore` 412 | SESSION `LOST · had 412 turns` |
| T6 | fresh launch, no history | SESSION `fresh` |
| T7 | lead cwd `/container-server` after clone refusal | SESSION `LOST`, reason names the cwd |
| T8 | `lastSnapshotAt` 61m old, running | SESSION suffix `snap 61m STALE` |
| T9 | stopped studio | renders as today |
| T10 | operation lock held | no override |

Integration:
- The restart-path test pushes a REAL staged restore through a heal. Today it
  stubs the R2 read to null (`studio.replacement.test.ts:118`, `:210`).
- Assert a verdict is recorded on each bring-up path.

### Deploy and verify

1. CI green on both lanes.
2. `git diff --stat origin/main...` lists no `apps/fleet/container/` path.
   Otherwise stop.
3. Worker deploy prints `Image already exists remotely, skipping push`.
   `wrangler containers instances` shows no instance created by it.
4. `git pull` in `/Users/you/code/fleetflare`. The CLI is symlinked there
   and is live on pull.
5. Live, read-only: running studios show SESSION `resumed · snap Nm`, and none
   shows a false `unreachable`. One owned studio (`fleetflare--*`) recycled
   on purpose records its verdict and snapshot age.
6. `replaced` cannot be triggered safely: recycle holds the operation lock
   through bring-up. Tests prove it. The next batched container window
   verifies it live. Say so in the PR; do not claim it.

## PR2 — the backup survives (design level; bounded, in-chat approval before build)

- **Sync guard.** Before `r2Put(latest)`, compare the candidate tar with the
  last uploaded one. Keep in the DO the newest session file, its line count
  and last timestamp, taken from the burn parse that already walks the tar
  every 300s. If the candidate lacks that file or has fewer lines in it, keep
  `latest`, write `sessions/<id>/displaced/<ts>.tar.gz` instead, and show it
  on SESSION.
- **Restore fallback.** If `latest` is poorer than the newest daily keeper,
  restore the keeper, and record `restore: daily <date>`.
- **Busy leads skip syncs?** Agent-inferred: GNU tar exits 1 on
  `file changed as we read it`, and the `&&` chain drops the upload (M3
  below). If measured true: `--warning=no-file-changed` and accept exit 1
  when `gzip -t` passes.
- **Pre-#89 keepers** hold old histories until ~2026-10-01 (7-day prune).
  No automatic restore: current sessions have moved on.

## PR3 — activity states (design level; needs the operator's approval before build)

Issue: https://github.com/rafarc21/fleetflare/issues/221

PR1 made the row tell the truth about the CONTAINER and the SESSION. It still
cannot say whether a lead is **working, idle at its prompt, waiting on
members, or parked on a limit**. Two costs, both measured:

- Every maestro screen-scrapes `esc to interrupt` out of a pane read today
  (`skills/fleet-cockpit/SKILL.md:255`). The BETA maestro asked for the field
  on 2026-09-25.
- Idle studios bill unnoticed. 3 demosite-life studios idled ~1h on 2026-09-24
  while their owner believed them gone.

The field this section designs is a new `ACTIVITY` column plus its JSON
equivalent. It is observation only. Nothing here stops, wakes or destroys
anything (Principle 2).

### Why no existing signal answers it

| signal | answers | cannot answer |
|---|---|---|
| `pane_current_command` | ALIVE or DEAD | reads `claude` for a lead mid-turn, a lead stopped on subagents, AND a lead parked on a modal (`cli/fleet.ts:400`, already written into `READY_CAVEAT`) |
| `BURN` | zero since spawn = nothing ever happened | output tokens only; freezes through reading and reasoning. A lead thinking 4 minutes and a lead stopped 25 show the same number (`skills/fleet-cockpit/SKILL.md:241`) |
| `LAST ACTIVITY` | when the registry row was last written | it is `lastRefresh` — bring-up and the 50-minute token loop. It never touches the lead (`cli/fleet.ts:203`) |
| `READY` | harness intact, lead present | PR1's own caveat: provisioned means ALIVE, not WORKING |

This is the whole reason the field is new rather than a relabel: **nothing
the fleet already stores separates thinking from stopped.** Only claude's own
screen does, and only hooks do it at the source.

### States and their evidence

Definitions, all reused, none forked:

- **frame** — the FIRST capture of a probe, trailing whitespace stripped.
  `failover.ts:875` already builds exactly this string.
- **footer** — `footerAtBottom(frame.split("\n"))`, #186's own rule
  (`failover.ts:218`): the last `FOOTER_LINE` with nothing under it but blanks
  and agent-panel rows. `< 0` means claude's live UI is not the bottom of the
  screen.
- **head** — frame lines `[0 .. footer]`, i.e. what `aboveAgentPanel` returns
  (`failover.ts:236`). The agent panel BELOW the footer ticks its own timers
  while the lead is idle, so it is never evidence about the lead.
- **status line** — the LAST `✻ ` line in **head**. Bottom-anchored, the same
  discipline `footerAtBottom`/`lastLineMatching` already use. Anchoring it is
  load-bearing: a lead that prints a pane capture into its own transcript
  (this spec, catted) puts a stale `✻ … esc to interrupt` on screen, and its
  own `✻ Cooked for 2m` turn-ended line then lands BELOW the quote.
- **wrap join** — each line is tested, then each line joined with the next.
  A corrupted render splits `esc to interrupt` across rows
  (`skills/fleet-cockpit/SKILL.md:263`, measured).

First match wins, top to bottom:

| ACTIVITY | evidence | real fixture |
|---|---|---|
| `LIMIT · resets 1:30pm (UTC)` | `row.rateLimited` set, from #99/#144's own detector on the same probe. **No re-parse here** | `REAL_PILOT_PANE` (`test/fixtures/rate-limit-panes.ts:493`), `REAL_WEBSTUDIO_PANE` (`:521`), `REAL_WEEKLY_DATED_PANE` (`:538`), `REAL_WEEKLY_TIMEONLY_PANE` (`:550`) — all four carry a reset. `V2_SESSION_LIMIT_PANE` (`:192`) has the OLD `│ > │` box chrome and no `⏵⏵` footer at all, so it would score `?` on the frame alone: precedence is what makes it render `LIMIT` |
| `LIMIT · modal — Esc (ff <id>)` | sighting has `select: true`. No clock ends it; a human presses Esc (#99) | `V1_FULL_PANE` (`:42`) |
| `WORKING 2m` | status line matches `esc to interrupt` | `REAL_PILOT_PANE` with `✻ Cogitated for 0s` → `✻ Cogitating… (3s · esc to interrupt)` — `test/studio.failover-real-panes.test.ts:56`, a real capture mutated only in its status line. Also `✻ Thinking… (12s · ↑ 1.4k tokens · esc to interrupt)`, `test/studio.account-failover.test.ts:111` |
| `WAITING MEMBERS 6m` | (a) status line matches `✻ Waiting for <n> background agent(s) to finish`; or (b) the agent-panel rows under the footer CHANGED between the probe's two captures | (a) `test/studio.failover-real-panes.test.ts:84-87`, and the same line verbatim in `REAL_PILOT_PANE` (`fixtures:500`). (b) `test/studio.failover-real-panes.test.ts:49-53`: `REAL_WEBSTUDIO_PANE`'s `◯ frontend-developer … 1h 1m 15s · ↑ 225.5k tokens` → `1h 1m 18s`, which that test already asserts is NOT a turn in flight |
| `IDLE 47m` | footer at bottom; status line is a `TURN_ENDED_LINE` (`failover.ts:160`) or absent; an input box (`RULE_LINE` then `PROMPT_LINE`, `failover.ts:162`/`:164`) sits between it and the footer | `IDLE` (`test/studio.failover-real-panes.test.ts:124` = `⏺ Done.` + `RULE_PROMPT`, `fixtures:23`). `REAL_WEEKLY_TIMEONLY_PANE`'s tail — `✻ Baked for 0s`, rule, `❯`, rule, footer — is the same shape, and reads `IDLE` once its limit is past |
| `IDLE ≥3m` | as above, but the DO has never yet watched this studio through a state CHANGE (first ticks after deploy, or after a bring-up) | — |
| `? claude not on screen` | `footer < 0` | `DEAD_FRAME` (`test/studio.failover-real-panes.test.ts:459`) — claude's whole last frame, footer included, above the `root@cloudchamber:/workspace#` prompt that replaced it. #170/#186 measured this exact frame fooling a footer-anywhere test |
| `? unrecognised frame` | footer at bottom, but head matches no rule above | — |
| `? probe failed` | the exec failed, or the pane section is absent from its stdout. A statement about the PROBE, never about the studio (`failover.ts:313`) | — |
| `? stale 12m` | the mirrored verdict is past its budget (below). Renders the AGE, never the stored word (Principle 1) | — |
| `—` | `state` is not `running` or `degraded`. A stopped studio has no lead to be active | — |

`LIMIT` duplicates what `READY` already says (`formatReady`,
`cli/readiness-format.ts:58`). Kept deliberately: `ACTIVITY` is the column a
maestro greps and it has to be answerable alone, and the alternative is worse
— a limited lead draws an ordinary idle input box, so without the override
`REAL_PILOT_PANE` and `REAL_WEEKLY_TIMEONLY_PANE` would both render `IDLE`.
One source of truth (`row.rateLimited`), two renderings.

### Signal source — the core recommendation

Baseline, one running studio, steady state: **~2.8 container execs/min**
(ship tick 2.0 at 30s, `do.ts:129`; session sync ~0.8 across four execs at
300s, `session-sync.ts:56`; token refresh 0.02 at 3000s, `do.ts:118`). The
pane probe is already one of them and already runs UNCONDITIONALLY every
300s on every non-stopped studio (`do.ts:1868` → `failover.ts:849`).

| option | execs/min added | other cost | latency | what it misses |
|---|---|---|---|---|
| **A** — reuse the existing 300s failover capture | **+0.00** | none | 0–300s, mean 150s | a turn shorter than 300s is invisible; `IDLE since` is granular to 300s only; two studios that stop 4 minutes apart look simultaneous |
| **B1** — fold ONE `capture-pane -p` frame into the existing 30s ship tick exec | **+0.00** (same exec) | ~+40ms and ~4KB of base64 stdout per tick, against a 45s tick budget (`do.ts:1987`) | 0–30s, mean 15s | the two-capture panel diff — one frame cannot show a timer moving. Taken from A instead |
| **B2** — a new dedicated 30s two-capture tick | **+2.00 (+71%)** | a 3s in-container `sleep` every 30s — 10% of every window, on `PANE_QUIESCE_SECONDS`' own design (`failover.ts:271`) | 0–30s | nothing over B1 |
| **C** — hook heartbeat, file read folded into the ship tick | **+0.00** | a `settings.json` install per bring-up | transition recorded at 0s, read at 0–30s | `LIMIT` (an API-error limit block fires no hook); `WAITING MEMBERS` (the lead is mid-turn while subagents run, so no `Stop`); a lead killed mid-turn (last state stays `WORKING` until staleness catches it); and, if **M4** answers no, every already-running lead |

On the one thing the fleet actually keeps getting wrong — **thinking vs
stopped** — A, B1 and C are all exact. `esc to interrupt` is repainted every
second for as long as a turn runs, reasoning included (`failover.ts:265`), and
`UserPromptSubmit`…`Stop` brackets the same interval at the source. The
options differ on cost, latency and coverage, not on that.

**Recommendation: B1 composed with A.** One frame on the 30s ship tick gives
the `WORKING / IDLE / LIMIT / ?` axis at 30s for zero new execs; the 300s
probe that already runs supplies the panel diff for `WAITING MEMBERS`, whose
subject (a member turn) lasts minutes, so 300s is the right granularity for
it. B2 buys nothing B1 does not and costs 71% more execs. C is an upgrade,
not a base — see M4.

Mechanics of B1: a new `SECTION_PANE` marker in `shipTickCmd`
(`transcript.ts:302`), beside `SECTION_BOOTID`/`SECTION_STAT`/
`SECTION_INCARNATION`. The precedent is already there: `paneLeadProbeCmd()`
is folded into the same exec on adoption ticks (`transcript.ts:325`). The
pane body is arbitrary text, so it is **base64'd** like `SECTION_CHUNK` and
`SECTION_TAIL` — that restores the hyphen-alphabet marker-safety argument
the file already documents (`transcript.ts:208-223`) and which raw pane text
would break. Command text is `withStudioTmux(capture-pane -p -t
studio:claude)` (`tmux.ts:50`), addressing the window BY NAME: it never
selects, switches or attaches anything (`failover.ts:281`). No `sleep`.

### M4, and what it changes

> **M4** Does claude 2.1.224 hot-reload hooks added to `settings.json`
> mid-session? If not, running leads get hooks at their next launch. Never
> force a relaunch (#70).

M4 decides how much C can ever be, and nothing else:

- **M4 = no.** Every currently-running lead produces no hook event until it
  relaunches. #70 forbids forcing that, and leads run for days. A hook-only
  PR3 would therefore ship **dark on the entire live fleet** — exactly the
  fleet the BETA maestro is asking about, and exactly the studios that idled
  for an hour. Hooks then arrive one bring-up at a time, silently, over days.
- **M4 = yes.** Hooks light up within one exec of install, and give
  transition times exact to the second instead of to a 30s frame.

Either way C cannot stand alone: it is blind to `LIMIT` and to
`WAITING MEMBERS`, and a lead killed mid-turn leaves it asserting `WORKING`
forever. **The pane leg is the floor under both answers. Hooks are an
upgrade on top of it, never the base.**

**While M4 is unmeasured: build the pane leg, install no hooks.** The
recommendation does not depend on M4, which is the point — PR3a is safe to
approve and build today. Measure M4 on the implementing studio by appending a
no-op hook to a live `settings.json` and watching for the file; that costs one
exec and relaunches nothing. Then:

- M4 = yes → **PR3b** installs the four hooks as a second leg. They sharpen
  `since` and close the ≤30s gap.
- M4 = no → **PR3b** installs them at bring-up only. `ACTIVITY` does not
  change meaning; coverage grows as studios cycle on their own.

**Hooks never override the pane.** `LIMIT` and `WAITING MEMBERS` come only
from the pane. On the `WORKING`/`IDLE` axis the FRESHER observation wins, ties
to the pane, and the rendered string names a hook source when it was one
(`WORKING 40s (hook)`). Rationale: this fleet's repeated failure is a
confident field contradicted by the screen, and the screen is what a human
checks.

Preserved from the pre-existing PR3 sketch, unchanged and still correct, for
PR3b: the four hooks (`SessionStart`, `UserPromptSubmit`, `Stop`,
`Notification`); Worker-side install in `runProvision`/`runRestart` via exec
into `settings.json`, with bring-up's merges keeping entries they do not own
(`studio-bringup.sh:894`, `:901`, `:973`) and re-install on every bring-up
because `/workspace` is wiped on replacement; script behaviour silent, always
exit 0, atomic tmp-then-mv write to `/workspace/.fleet/activity.json`, because
`SessionStart`/`UserPromptSubmit` stdout enters the lead's context and exit 2
blocks the call; the event→state map (`UserPromptSubmit`→WORKING,
`Stop`→IDLE, `Notification permission_prompt`/`elicitation_dialog`→WAITING,
`idle_prompt`→IDLE); `SessionStart source` cross-checking PR1's verdict; the
ship tick reading the file in the same exec; own DO key, D1 write on state
change only; raw ages only, no threshold acted on (read #90 before any
threshold is ever set).

Replaced: hooks as the PRIMARY and only source (M4 can make that ship dark),
and the jsonl-`timestamp`/pane-log-growth second leg (`burn.ts:192-201`),
which measures file writes and so cannot separate a lead reasoning from a
lead stopped — the one thing the field exists to do.

### Staleness

Two readers, two budgets, both by Principle 1 — the reader computes the age
and a verdict past its budget renders `?` with that age, never the stored
word.

- The DO key is rewritten every ship tick (30s). `fleet inspect` and
  `GET /studio/:id/status` read it and use **3 × 30s = 90s**, the same
  three-consecutive-ticks shape PR1 uses for `unreachable`.
- The D1 mirror is written **on state change only**, so a steady `IDLE` row
  would freeze its `observedAt` and go stale by construction. `observedAt`
  therefore rides the existing 300s burn mirror (`do.ts:1154-1164`), exactly
  as PR1's `lastSnapshotAt` does — **zero extra writes**. `fleet ls` reads the
  mirror and uses **2 × 300s + 60s = 660s**, the budget PR1 already uses for
  `unverified`.

`since` is the first observation of the CURRENT state and does not move while
the state holds. Until the DO has watched one state CHANGE it is a lower
bound and renders with `≥`: after a deploy or a bring-up the studio may have
been idle far longer than the fleet has been looking.

`ACTIVITY` renders `—`, and no verdict is stored, while `state` is not
`running`/`degraded`, and while the operation lock is held (#86/#87) — a
bring-up in flight has no lead to read, the same carve-out PR1's overrides
take.

### Storage and the JSON field

```ts
type Activity = {
  state: "working" | "idle" | "waiting-members" | "limit" | "unknown";
  since: string;            // first observation of THIS state, ISO
  anchored: boolean;        // false until a state CHANGE has been observed
  observedAt: string;       // the capture this verdict came from, ISO
  source: "pane" | "hook";  // always "pane" in PR3a
  reason: string | null;    // always set when state is "unknown"
  membersTickingAt: string | null; // last 300s probe that saw the panel move
};
```

Own DO key, `activity` (Principle 4: never in `status.error`, never inside the
status read-exec-write cycle, `do.ts:1421-1431`). D1 mirror rides PR1's
existing optional `observed?` blob as `observed.activity` — no migration, one
cleaner. `GET /studio/:id/status` and `fleet ls --json` expose it verbatim, so
a maestro reads a field instead of scraping a screen.

### The ACTIVITY column

`formatActivity(status, now)` in the pure `cli/readiness-format.ts`, tested
like `test/cli.fleet.test.ts:70-131`. `formatTable` (`cli/fleet.ts:245`) gains
`ACTIVITY` immediately after `SESSION`.

Ride-along, which PR1 explicitly deferred to here ("`LAST ACTIVITY` keeps its
label … PR3 revisits it once real activity exists"): rename `LAST ACTIVITY` to
`REFRESHED`. It has always been `lastRefresh` (`cli/fleet.ts:203`), it never
touched the lead, and leaving it beside a real `ACTIVITY` column is the exact
confusion this spec exists to remove.

`READY_CAVEAT` (`cli/fleet.ts:399`) and `fleet help` gain one line naming
`ACTIVITY` as the working-or-stopped answer and `READY` as the alive-or-dead
one. `fleet inspect` prints the stored verdict and its reason at zero
container cost, as PR1's lines do.

### What ACTIVITY must NEVER claim

1. **It must never guess between thinking and stopped.** When the frame is
   ambiguous it says `?` with a reason. The exact rule: `?` whenever
   `footerAtBottom(frame) < 0`, OR the probe failed or its section is absent,
   OR head has a footer at the bottom but matches none of `LIMIT`, `WORKING`,
   `WAITING MEMBERS` or `IDLE` above, OR the verdict is past its staleness
   budget. `?` always carries its reason (Principle 5).
2. **It must never fall back to another signal.** Not
   `pane_current_command`, not `BURN`, not `LAST ACTIVITY`, not transcript
   growth. Each of those answers a different question and has already been
   measured answering this one wrongly.
3. **It must never read the agent panel as the lead.** The panel below the
   footer ticks while the lead is idle — the rule `aboveAgentPanel` already
   encodes (`failover.ts:236`), and the reason `WAITING MEMBERS` is a state of
   its own rather than a flavour of `WORKING`.
4. **It must never state a `since` it has not watched.** Before the first
   observed transition the age is a lower bound and renders `≥`.
5. **It must never assert a state from a hook alone** where the pane can
   contradict it.

(Items 6-8, added for issue #311's memguard-kill/member-liveness/poll-loop
addendum, live in "PR3 addendum (issue #311)" below, next to the member-alert
machinery they constrain — kept there rather than renumbered into this list
so the addendum stays a self-contained unit a reviewer can read on its own.)

Known residual, accepted and named: a lead can print a pane capture into its
own transcript. The status line is bottom-anchored to defeat the common case
(the lead's own turn-ended line lands below the quote), but a lead sitting
with a quoted `✻ … esc to interrupt` as the last `✻` on screen and no turn
after it reads `WORKING` while idle. Blast radius is one column on one row,
it self-corrects on the lead's next turn, and nothing acts on the value.

### Out of scope for PR3 — stated here on purpose

**Idle-stop and auto-destroy are NOT in this change and are not this
section's to propose.** Turning `IDLE 47m` into a stop is a spend decision and
**the operator's alone**. PR3 makes the idling visible and stops there. Also out:
any watchdog or threshold acted on, and any Telegram alert.

### Test plan (outline only — nothing is written until this is approved)

Unit, `formatActivity`, pure, fixtures replayed:

1. each row of the state table above renders its own word, from the named
   real fixture;
2. `REAL_PILOT_PANE` mutated to `✻ Cogitating… (3s · esc to interrupt)` →
   `WORKING`, and unmutated with its limit → `LIMIT`, proving precedence;
3. `DEAD_FRAME` → `? claude not on screen`, never `IDLE`;
4. `V2_SESSION_LIMIT_PANE` (box chrome, no footer) → `LIMIT` by precedence,
   and `?` when the sighting is absent — never `IDLE`;
5. the wrap join: `esc to interrupt` split across two rows still reads
   `WORKING`; the phrase in ⏺ prose above a later `✻ Cooked for 2m` does not;
6. `since` holds across same-state observations and resets on change;
   `anchored: false` renders `≥`;
7. staleness: 90s on the DO read, 660s on the mirror, each rendering
   `? stale <age>` and never the stored word;
8. `state: stopped`, and the operation lock held, each render `—`.

Frame parsing, against the committed captures: every fixture in
`NOT_DETECTED`, `NOT_DETECTED_106`, `NOT_DETECTED_OUT_OF_CREDITS_PROSE` and
`RELAXED_TAIL_NEGATIVES` gets an expected `ACTIVITY`, and none of them reads
`WORKING` — the same negative-corpus discipline #106/#112 forced on the limit
detector.

Panel diff: `REAL_WEBSTUDIO_PANE` vs its `1h 1m 18s` mutation →
`WAITING MEMBERS`; byte-identical captures → no member evidence.

Plumbing: `shipTickCmd` emits `SECTION_PANE`, base64'd, and the parser
tolerates it being absent (pre-feature container) and being empty (tmux gone);
the exec issues no `sleep` and adds no second exec; a failed exec yields
`unknown` and never throws into the alarm; the D1 write fires on change only
and `observedAt` advances on the 300s mirror.

No `apps/fleet/container/` file is touched, asserted the way PR1 asserts it:
`git diff --stat origin/main...` lists no such path.

**No real-tmux test and no manual tmux. Ever.** Every case above replays a
committed capture.

### PR3a implementation plan

Kept in this file rather than `docs/superpowers/plans/` on purpose: nothing is
approved yet, and a plan doc that outlives a rejected design is worse than no
plan doc. It moves out on approval.

Global constraints, every task: TDD, failing test first. Worker + CLI only —
**zero files under `apps/fleet/container/`**. No new container exec: the pane
frame rides `shipTickCmd`'s existing one. No `sleep` added to any tick. No
real-tmux test, ever. Every fixture replayed is already committed in
`apps/fleet/test/fixtures/rate-limit-panes.ts`. Commit after every task.

**Task 1 — `readActivityFrame`, the pure frame reader.**
Create `apps/fleet/src/studio/activity.ts`; test
`apps/fleet/test/studio.activity.test.ts`. Imports `footerAtBottom`,
`aboveAgentPanel`, `TURN_ENDED_LINE`, `RULE_LINE`, `PROMPT_LINE`,
`AGENT_PANEL_LINE` from `failover.ts` — which means exporting them there, one
line each, no logic change.
Produces: `readActivityFrame(frame: string): FrameVerdict` where
`FrameVerdict = { kind: "working" | "waiting-members" | "idle" } | { kind:
"unknown"; reason: string }`. Note: no `limit` — Task 3 layers that on.
Tests, one per state-table row, each named after its fixture: the mutated
`REAL_PILOT_PANE` → `working`; the `✻ Waiting for 1 background agent to
finish` fixture (`studio.failover-real-panes.test.ts:84-87`) →
`waiting-members`; `IDLE` and `REAL_WEEKLY_TIMEONLY_PANE`'s tail → `idle`;
`DEAD_FRAME` → `unknown`, reason `claude not on screen`. Plus the whole
negative corpus (`NOT_DETECTED`, `NOT_DETECTED_106`,
`NOT_DETECTED_OUT_OF_CREDITS_PROSE`, `RELAXED_TAIL_NEGATIVES`) asserted to
never return `working`, and the two wrap-join cases.

**Task 2 — `nextActivity`, the state machine.**
Same file. Produces `nextActivity(prev: Activity | null, verdict:
FrameVerdict, limit: RateLimitObservation | null, membersTickingAt: string |
null, now: Date): Activity`, with `Activity` exactly as typed above.
Tests: `since` holds across same-state observations and resets on change;
`anchored` is false until the first observed change; `limit` outranks every
frame verdict; a `waiting-members` verdict and a fresh `membersTickingAt`
both reach `waiting-members`; an `unknown` verdict never inherits the
previous state's word.

**Task 3 — `SECTION_PANE` on the ship tick.**
Modify `apps/fleet/src/studio/transcript.ts:302` (`shipTickCmd`) and its
parser; test `apps/fleet/test/studio.transcript.test.ts`. Adds
`SECTION_PANE = "---FLEET-PANE---"` beside its siblings, and
`withStudioTmux(capture-pane -p -t studio:claude) | base64` after the
incarnation read. Tests assert: the emitted string contains exactly one
`capture-pane`, no `sleep`, and no second exec; the parser round-trips a
fixture pane through base64; an absent section yields `undefined`, not a
throw; an empty section yields `unknown`, reason `pane empty`.

**Task 4 — wire it into the tick and storage.**
Modify `apps/fleet/src/studio/do.ts` (ship tick body; `ACTIVITY_KEY =
"activity"`; the 300s mirror at `:1154-1164`, which also carries
`observed.activity` onto the D1 row so `GET /studio/:id/status` and
`fleet ls --json` expose it with no further work) and
`apps/fleet/src/studio/failover.ts:875`
(record `membersTickingAt` when the two captures' panel rows differ — the
captures are already both in hand there). Tests in
`apps/fleet/test/studio.do.test.ts` and
`apps/fleet/test/studio.failover-real-panes.test.ts`: the DO key is written
every tick; the D1 mirror is written on state change only; `observedAt`
advances on the 300s mirror with no extra write; a failed exec yields
`unknown` and never throws into the alarm; a `stopped` studio and a held
operation lock store nothing.

**Task 5 — `formatActivity` and the column.**
Modify `apps/fleet/cli/readiness-format.ts` and `apps/fleet/cli/fleet.ts`;
test `apps/fleet/test/cli.fleet.test.ts`. Produces
`formatActivity(status: StudioStatus, now: Date): string`, rendering exactly
the strings in the state table, reusing `formatAge`
(`cli/readiness-format.ts:78`) for every age. `formatTable` gains `ACTIVITY`
after `SESSION`; `LAST ACTIVITY` becomes `REFRESHED`; `READY_CAVEAT` and
`fleet help` gain their line. Tests: every rendered string in the state
table; both staleness budgets (90s, 660s) rendering `? stale <age>` and
never the stored word; `—` for a stopped row; the header row reads
`… SESSION ACTIVITY CHECKED …` and no longer contains `LAST ACTIVITY`.

**Task 6 — measure M6, M7 and M4, then report.**
No code. One day of Worker-tail counting on `fleetflare--web-studio` for the
`?` rate (M7) and the panel glyphs (M6); one appended no-op hook for M4.
Findings go back into "Open measurements" above, and PR3b is scoped from
them.

Verification before anything is called done:
`git diff --stat origin/main...` lists no `apps/fleet/container/` path; both
CI lanes green; the Worker deploy prints `Image already exists remotely,
skipping push`.

### PR3 delivery

PR3a (pane leg) first, on its own review. M4 measured on the implementing
studio during PR3a. PR3b (hooks) only after M4 has an answer, and only if it
buys something PR3a did not. Worker + CLI only; image digest unchanged, so
the deploy must print `Image already exists remotely, skipping push`.

### PR3a fix round 2 (issue #221, this round) — addendum, not a redesign

Six measured gaps in the PR3a HOLD review, fixed in place rather than
reopening the design:

1. **Mid-turn misread as idle.** The spinner glyph is not always `✻`
   (measured live: `·`, `✶`), and `esc to interrupt` can paint into the
   FOOTER instead of the status line. `readActivityFrame` now reads EITHER
   as working evidence, never only the hardcoded-glyph status line.
2. **Precedence order.** This file's own state table always put WORKING
   above WAITING MEMBERS (see "First match wins, top to bottom" above);
   `nextActivity`'s code had it backwards (checked a fresh `membersTickingAt`
   before `verdict.kind === "working"`). Fixed to match the table — no
   design change, a code bug against an already-correct spec.
3. **Limit stuck past reset.** `nextActivity` forced `"limit"` for as long as
   `row.rateLimited` was non-null, with no check that its OWN printed
   `until` had already passed. Now a `limit` observation only outranks the
   frame while genuinely still live (a `select` modal or an unreadable
   `until` still never expire, unchanged) — past its reset, the real frame
   verdict takes over the next tick, self-healing within 30s instead of
   parking on a bare `?` forever.
4. **ACTIVITY_KEY survives stop/bring-up.** Neither was ever cleared on a
   container stop or a fresh provision/restart/recycle, so `since`/
   `anchored` could describe a state from a PREVIOUS incarnation. Both keys
   are now cleared at both lifecycle points (`activity.ts`'s
   `clearActivityState`, called from `do.ts`'s `onStop` and its two bring-up
   entry points).
5. **`? probe failed` never really fired.** The design's own state table
   names this verdict, but the real exec-failure path rethrew past the
   activity write entirely — only a test injecting the state by hand ever
   produced it. The ship tick's catch block now writes it for real before
   rethrowing, through the SAME write path (`applyActivityVerdict`) a
   successful probe uses. `fleet inspect` also gained the `activity:` line
   this state (and every other) needs to be visible in, using the
   `ACTIVITY_DO_STALE_SECONDS` (90s) budget this file always specified for a
   DO-direct reader but which had no real caller until now.
6. **A new state: `waiting-question`.** Not in the original state table —
   added this round because a select-style menu (a permission prompt
   included, `Do you want to proceed?`) is its own thing, never a flavour of
   idle, the same "own state, not a flavour of working" reasoning already
   applied to WAITING MEMBERS. Detected via the SAME `▔`-ruled/`Enter to
   confirm · Esc to cancel` shape the rate-limit modal draws
   (`MODAL_FOOTER_LINE`/`MODAL_BLOCK_START`, failover.ts), reused rather than
   forked. Renders `WAITING QUESTION <age>`. A live studio was measured
   parked on exactly this prompt, misread as IDLE, before this fix.

PR3b (hooks) and Task 6/M4's own measurement pass remain explicitly open —
this round is Worker/CLI/tests only, same boundary as PR3a itself.

### PR3 addendum (issue #311) — memguard kills, member liveness, poll-loop guard

Measured 2026-09-25 (cto-7c): a studio lead polled a background member for
1h10m / 506.3k tokens while that member's vitest run had already hit the
container's memory ceiling and been killed by memguard (#104's failure
class). A second studio's member was "Baked 34m · 2 shells still running",
also wedged. Both rows read `IDLE 10m`/`IDLE 20m` — indistinguishable from a
lead legitimately waiting on a long, healthy run. Three asks, all
observation-only, all Worker/CLI/tests (no `apps/fleet/container/` change —
`container/memguard.ts` already writes a kill log at
`${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log`, one line per kill, and
nothing on the Worker side reads it today; this addendum reads that existing
format, it does not change what memguard writes).

**Source, reusing PR3a's own B1 recommendation.** A new `SECTION_MEMGUARD`
marker rides the SAME chained exec `shipTickCmd` (`transcript.ts`) already
issues every 30s — `tail -n 20` of the log, base64'd like every other
section, guarded (`2>/dev/null`) so a studio predating this feature, or one
whose log does not exist yet, never fails the tick. Zero new execs, same "no
new actor" posture PR3a's own B1 leg took for the pane frame. The member-row
data (name, elapsed time, token count) needed for the poll-loop guard and
the member-gone signal is ALSO already captured every 30s — it is the same
`SECTION_PANE` frame `activity.ts`'s `agentPanelRows` already slices out for
the panel-diff leg, just never parsed field-by-field before now.

**New files, not folded into `activity.ts`.** `src/studio/memguard-log.ts`
parses memguard's own log-line format (`formatLogLine`,
`container/memguard.ts:508-516`) into `MemguardKillLogEntry` — a pure
regex-based parser over text the container already redacts and truncates
(`memguard.ts`'s own `redact()`, 200-char cut on `cmd` — this addendum does
not re-redact, re-truncate, or second-guess that; whatever memguard.ts
already considered safe to log is what this surfaces, verbatim).
`src/studio/member-alerts.ts` holds the member-row parser
(`parseMemberRows`, over `activity.ts`'s existing `agentPanelRows` output —
no re-parse of the footer/panel boundary, same "reuse, don't fork" rule
PR3a's own header states), the poll-loop threshold check, the gone-row diff,
and the `MemberAlert` type. Kept separate from `activity.ts` because
`Activity` is deliberately about the LEAD alone (this file's own
"must never read the agent panel as the lead" rule, restated below) — a
member's own row crossing a threshold, or vanishing, is a fact about a
DIFFERENT process than the one `Activity.state` describes, and folding it
into the same type would blur that boundary the moment a reader had to ask
"whose state is this."

**Storage.** Own DO key, `memberAlerts` (`MEMBER_ALERTS_KEY`), same "own key,
D1-mirrored via `Observed.memberAlerts`, never inside `OBSERVED_KEY`'s own
read-patch-write cycle" convention `ACTIVITY_KEY` already established
(Principle 4). A second, smaller key, `memberRows` (`MEMBER_ROWS_KEY`),
holds only last tick's member-row NAMES (not full rows — nothing else is
needed across ticks, since elapsed/tokens are read fresh off the row itself
every 30s and never need a historical baseline) so a tick can tell a row
vanished. Both keys are recomputed and OVERWRITTEN every tick — no
ever-growing accumulation, no cap-and-trim logic to get wrong — matching
Principle 1: the reader computes age off each alert's own `at`, the writer
never pre-renders "N minutes ago" into stored text. Both keys are cleared on
container stop and at both bring-up entry points, via the SAME
`clearActivityState` (`activity.ts`) `ACTIVITY_KEY`/`MEMBERS_TICKING_KEY`
already route through — a stopped-then-brought-up studio has no continuous
member-row history for a "row vanished" diff to describe, the identical
reasoning that function's own doc comment already gives for activity state.

**Ask 1 — memguard kill surfaced as a row note.** The freshest kill still
inside `MEMGUARD_ALERT_RETENTION_S` (10 minutes — chosen as "long enough for
an operator polling every few minutes to still catch it," not measured
against real polling cadences; a placeholder, named as such) becomes a
`MemberAlert{kind: "memguard-kill", confidence: "measured"}` whose `detail`
carries `comm`/`rss_mib`/`pid` straight from the log line. Rendered by
`cli/readiness-format.ts`'s new `formatMemberAlert` as
`member killed by memguard <age> ago (comm=<c> rss_mib=<n> pid=<p>)` — the
issue's own example wording, with the extra fields the issue itself asked
for ("enough detail to be useful"). Surfaced in TWO places, both reads of
the SAME stored `Observed.memberAlerts`, satisfying the issue's "surfaces as
an ACTIVITY state ... and a row note" in the way that best fits this
codebase's existing shapes (Principle 4 leaves the exact shape to the
implementer): `formatActivity`'s own returned string gains a `" · "`-joined
suffix when a fresh alert exists (so it shows up in the ACTIVITY column
itself, the thing a maestro already greps), and `fleet inspect`'s
`formatObservedLines` gains one `member alert:` line per current alert (the
full-detail read, matching how `session:`/`activity:` already work there).
**MUTANT PROOF (a):** `test/studio.member-alerts.test.ts` asserts that a
memguard kill line present in the ship-tick stdout produces a
`memguard-kill` alert; deleting `readShipTickMemguardKills`'s parse call (or
`parseMemguardKillLines`'s own regex) turns this test red, never green —
a kill that DID happen cannot silently produce zero alerts.

**Ask 2 — member death, surface-only, and ONLY when corroborated.** Principle
2 states nothing here heals, restarts, wakes or recycles, and this addendum
does not add a new actor — the PR4b wake is the one exception the spec
already names, already spent, and not reopened here. "The lead is told when
a member process dies" is read the same way every other signal in this spec
already is: visible via `fleet ls`/`fleet inspect` to a human maestro, and to
the lead itself if it chooses to run either on itself — never a pane
injection or a `send-keys` wake. **Confidence, stated plainly:** there is no
mechanism today, anywhere in this fleet, that watches ONE specific member
process's lifetime end-to-end — the only two signals available are (a) a
member's row disappearing from the panel between two ticks, and (b) memguard's
own kill log, which records a `comm`/`cmd`/`pid`, never a member NAME. A row
can vanish for the most ordinary reason there is — the member finished
cleanly — and nothing measured in this repo distinguishes that from a row
vanishing because its process was killed (see **Open measurements**, below,
for the exact question this would take to answer). Rather than guess, this
addendum emits a `member-gone` alert **only** when a row vanishes within
`MEMBER_GONE_CORRELATION_S` (90s — three ship ticks, the same
cadence-multiple shape `ACTIVITY_DO_STALE_SECONDS` already uses) of an actual
memguard kill, and marks it `confidence: "inferred"` — a correlation across
two independent noisy signals, explicitly NOT an attribution to that
specific member's row. The rendered detail says so
(`"<name> — row vanished within 90s of a memguard kill (comm=<c>); not a
proven match"`). A row vanishing with NO nearby kill produces no alert at
all — the honest "we don't know" the confidence gap above demands, not a
guess dressed up as a verdict. **MUTANT PROOF (b):**
`test/studio.member-alerts.test.ts` covers both directions: a row vanishing
with a corroborating kill in the same tick window DOES produce a
`member-gone` alert; the SAME row vanishing with NO kill anywhere nearby
produces NONE — a test that deletes the correlation-window check (so every
vanished row alerts, kill or not) turns the second case red. This is the
"never claim a member died when it merely finished cleanly" guarantee the
task asked for, to the exact extent current evidence supports it.

**Ask 3 — poll-loop token guard.** Every current member row whose own
printed elapsed time or token count crosses a threshold produces a
`MemberAlert{kind: "poll-loop", confidence: "measured"}` — "measured" because
this reads the row's own printed fields directly, no inference. Thresholds,
named as constants with a stated rationale:

```ts
export const POLL_LOOP_ELAPSED_MINUTES = 30; // OR, not AND, against tokens below
export const POLL_LOOP_TOKENS = 300_000;
```

**Explicitly NOT measured** against a real distribution of healthy-vs-wedged
member timings — chosen only to sit comfortably below BOTH figures this
issue itself measured (1h10m/506.3k tokens; 34m), so both real wedge
incidents that motivated this issue would have flagged, while staying above
the kind of ordinary tool-use wait this repo's own fixtures show elsewhere
(no real fixture pane in this repo shows a healthy member past ten minutes).
Either threshold alone flags (OR): a wedged process can show a frozen token
count with climbing elapsed time just as easily as it can show a large but
still-growing count, and this addendum has no measured way to tell those
apart yet (see **Open measurements**). Explicitly named as needing
real-world tuning once this ships and produces real samples — not asserted
as correct today.

**PR #336 round 2 review — three fixes, addendum not a redesign:**

1. **The D1 mirror was firing every tick, unbounded, for the whole duration
   of any long-running member.** `MemberAlert.at` was stamped `now` on every
   tick a poll-loop row stayed flagged, so the equality check deciding
   whether to fire an out-of-cadence D1 write (`sameAlertSet`, do.ts) — a
   whole-object compare — read the array as "changed" every single 30s tick
   (a different `at`, a different elapsed-minutes `detail`), not only when
   the alert set genuinely changed. Fixed two ways together: `sameAlertSet`
   now compares `kind`+`name` SET membership only, never the full object; and
   `buildMemberAlerts` carries a poll-loop alert's `at` forward from
   `prevAlerts` for the SAME name, stamping `now` only on a row's first
   crossing. This also fixes a second bug the same root cause produced: the
   rendered "<age> ago" (`formatMemberAlert`) could never read as more than
   ~0s, since it was always measured against a timestamp that was itself
   always "now."
2. **Label honesty.** The detector cannot tell a genuinely wedged poll loop
   from a legitimate long-running job crossing the same unmeasured threshold
   (see M10, below) — asserting "poll-loop" claimed more certainty than the
   evidence supports. `formatMemberAlert`'s rendered verb for this alert kind
   is now `long-running member <name>` (the internal `MemberAlertKind` stays
   `"poll-loop"`, an implementation detail never shown to a reader).
3. **`MEMGUARD_LOG` override.** The ship-tick's own read of the kill log
   (`transcript.ts`'s `MEMGUARD_LOG_PATH`) mirrored container/memguard.ts's
   `FLEET_WORKSPACE` fallback but not its higher-priority `MEMGUARD_LOG` env
   var (memguard.ts:537) — a studio overriding `MEMGUARD_LOG` directly would
   have this section silently tail the wrong file. Now resolves in the same
   order memguard.ts itself does.

**What ACTIVITY must NEVER claim, extended for #311:**

6. **It must never attribute a memguard kill to a specific member's row
   without corroborating evidence, and even then only as `inferred`,
   never `measured`.** A kill's own log line carries no member name — only
   `comm`/`cmd`/`pid` — so any row-name pairing is, at best, "these two
   things happened close together," never "this process was that row."
7. **It must never treat a vanished row, alone, as evidence of death.** A
   row disappearing is equally consistent with the member finishing
   cleanly, which is the ordinary, expected, good outcome. Only a
   corroborating memguard kill inside the correlation window earns a
   `member-gone` alert, and it is marked `inferred`, never asserted as fact.
8. **It must never act on a poll-loop or memguard-kill alert.** Principle 2,
   restated for #311: no kill, no wake, no auto-anything. These alerts exist
   so a human (or a lead inspecting itself) can decide to stop polling or
   intervene — the fleet itself does neither.

**States and their evidence, extended:** no new `Activity.state` value was
added — `WORKING`/`IDLE`/`WAITING MEMBERS`/`LIMIT`/`WAITING QUESTION`/`?`
still describe the LEAD exactly as before (Principle 3, restated:
"must never read the agent panel as the lead" — a member alert is
information ABOUT the panel, so it rides beside `Activity`, in
`Observed.memberAlerts`, never inside `Activity.state` itself). The row's
rendered ACTIVITY string is `<lead state> · <freshest member alert>` when
one exists, `<lead state>` alone otherwise.

PR3 addendum (issue #311) is Worker/CLI/tests only, same boundary every prior
round of this spec has held — `container/memguard.ts` is unchanged.

## PR4 — a restarted lead learns what survived (#107)

Measured 2026-09-24 by the BETA coordinator: after a recycle,
`demosite-life--release-studio`'s lead pushed a real commit 6 minutes after a
re-brief that named its surviving branches (`fix-796-t6-error-surface`,
13:38:11Z). Three earlier recycle rounds on the same studio lost everything;
round 4 recovered in minutes once told what was still on origin. The
expensive part of a recovery was never the container — it was the lead not
knowing what survived. Studio clones are shallow and single-branch
(fleet-cockpit's own note: "rescue branch invisible to the next container"),
so a fresh lead cannot even see its own pushed branches without being told.

Today every coordinator does this re-brief by hand, reading `git log
origin/main..origin/<branch>` and the board by eye. This spec section covers
the composition only (PR4a); delivery is PR4b, below.

### PR4a — the composer (this PR)

The PURE composition: given a studio's assigned task branches, open PRs, and
its last bring-up session verdict, produce the "what survived" text block. No
I/O, no delivery, no wiring into any wake/bring-up path.

`apps/fleet/src/studio/survival-brief.ts` (real current shape, re-review round
2 — `session: ObservedSession | null` replaced the original `lastSnapshotAgeS:
number | null`; `tasks`/`openPrs` are `Checked<T>` so a failed lookup renders
"could not check (<reason>)" rather than collapsing to a silently blank
section):

```ts
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SurvivalTaskBranch {
  taskNumber: number;
  taskTitle: string;
  branch: string | null;
  commitsAheadOfMain: number | null;
  lastCommitAt: string | null;
}

export interface SurvivalOpenPr {
  number: number;
  title: string;
  branch: string;
}

export interface SurvivalInput {
  studioId: string;
  tasks: Checked<SurvivalTaskBranch[]>;
  openPrs: Checked<SurvivalOpenPr[]>;
  session: ObservedSession | null;
  now: string;
}

export function composeSurvivalBrief(input: SurvivalInput): string;
```

Design decisions:
- `commitsAheadOfMain` arrives already resolved — the composer takes it as
  input and does no counting of its own. The caller (PR4b) must resolve it
  from GitHub's compare API (`main...<branch>`, reading `ahead_by`; see
  PR4b's own "Commits-ahead count source" note below), NEVER from `git log`
  run inside a studio's own clone: studio clones are shallow and
  single-branch, so a `git log origin/main..origin/<branch>` inside one
  overcounts — reviewer measured a genuinely 0-ahead branch reading 1-3
  ahead. Same discipline as the fleet's own `#98` push-rule elsewhere in this
  repo ("count commits, never refs"): 0 is a real, checked value that must
  render as EMPTY, not be excluded or confused with "never checked" (`null`
  renders "commits ahead unknown" instead).
- Every age is computed from a stored ISO timestamp at composition time (the
  `now` parameter) EXCEPT `session.snapshotAgeS` — same Principle 1 PR1
  already established: the reader computes age, nothing stores a
  pre-rendered string. The one exception is deliberate: PR1's own
  `ObservedSession.snapshotAgeS` is captured ONCE, AT RESTORE TIME (its own
  doc comment, `observed.ts`), and this composer passes it through exactly
  as recorded — it is not, and must not be, recomputed from a later
  timestamp (`Observed.lastSnapshotAt` is a different, unrelated field: the
  age of the CURRENT session's latest upload, not the RESTORED snapshot's
  age at the moment it was restored).
- Imports PR1's real `ObservedSession` TYPE from `./observed` — a normal
  same-layer, sibling-file import inside `src/studio/`, not a layering
  violation: `cli/readiness-format.ts` imports FROM `src/studio/`, never the
  other way, and that direction is unchanged by a type import between two
  files that already live in the same `src/studio/` layer. `formatAge`
  itself stays duplicated (as `formatSurvivalAge`) — it lives in `cli/`,
  which imports `src/`, never the reverse, so importing it FROM
  `cli/readiness-format.ts` INTO this `src/studio/` file would be the
  illegal direction. Consolidating the two duplicated bucketing functions,
  once both sides agree to share one, is a one-line follow-up, not a
  blocker for this PR.
- Empty input (no live task branches, no open PRs, no bring-up verdict
  recorded) composes to `""` — the empty string is itself the signal that
  there is nothing worth re-briefing about; a future caller (PR4b) decides
  whether to skip delivery entirely on an empty result.

### PR4b — delivery (future, blocked, not in this PR; needs the operator's explicit
approval before build, see Delivery below)

**Trigger — an explicit allowlist, nothing else fires it:**
- a bring-up with `via: "recycle"` or `via: "heal"` (`#85` PR1's field), OR
- a bring-up where `Observed.replacedAt` was set (a replacement was detected
  regardless of which verb brought the studio up).

Never on `via: "adopted"` — that verdict fires on EVERY already-running
studio the instant PR1 itself deploys; re-briefing the whole fleet
simultaneously at deploy time would be absurd. Never on `via: "failover"` —
an account switch, not a container replacement; nothing was lost. Never on a
first/fresh `via: "provision"` — there is nothing yet that could have
survived.

**"Lead is mid-task, don't interrupt" — two independent busy signals, either
one says busy → deliver nothing this sweep tick, retry next one, never
force:**
1. Reuses failover.ts's own probe: capture the pane, wait
   `PANE_QUIESCE_SECONDS`, capture again (`paneCaptureCmd`,
   `failover.ts:260-300`). Byte-identical captures mean genuinely idle;
   claude repaints its own status line (`✻ Thinking… (12s · ... · esc to
   interrupt)`) every second while a turn runs, so a repainted pane means a
   turn is in flight.
2. Independently, an `esc to interrupt` row at the bottom of a single pane
   capture is itself a busy signal — claude prints that row only while a
   turn is running, so it needs no second capture to read.

**Commits-ahead count source — corrected.** NEVER `git log` inside a
studio's own clone: studio clones are shallow and single-branch (this
section's own opening measurement above), so `git log
origin/main..origin/<branch>` run inside a studio counts a genuinely
0-ahead branch as 1-3 ahead (reviewer measured this directly). The Worker
instead calls GitHub's compare API from outside the studio — `main...
<branch>` — and reads `ahead_by` from the response body, the same pattern
`apps/fleet/src/github/api.ts`'s `commitReachableFromBranch` (~818-832)
already establishes for a related comparison. `ahead_by: 0` is genuinely
EMPTY and renders as such (never dropped — that silent drop is the whole
complaint #107 exists to fix). An API error renders `unknown`, never a
fabricated `0` and never a silently dropped task line.

**Dependencies.** `#99` (the modal-detection gate) is ALREADY MERGED, as
`#114`. `#85` (PR1 — replacement detection, session verdict, `via`,
`Observed.lastSnapshotAt`) is ALREADY MERGED, as `075b14a`. `#141` (the
wake-race single-flight guard: one exec, scan-type-rescan-Enter, per-DO
`wakeLock`) is ALSO ALREADY MERGED, as `eabc29e`. Every dependency this
section names is now on `main` — the only real gate left on PR4b is the operator's
explicit approval to build it (see Delivery, below). PR4b delivers through
the existing `runGatedWake`
(`apps/fleet/src/studio/wake.ts:317`) — inside that same single-flight gated
wake, never a second, competing wake path. A wake that `runGatedWake` skips
(modal on screen, rate-limited, lock held, busy signal above, etc.) simply
retries on a later sweep tick; it is never forced through. At most once per
incarnation: delivery is recorded against PR1's incarnation token, in the
DO's `observed` record (a new field alongside `incarnation`/`replacedAt`) —
described here, not implemented until approval lands.

**Snapshot age.** Primary source is PR1's own `session.restore` /
`session.snapshotAgeS`, recorded once at bring-up — the snapshot's age AT
THE MOMENT it was restored. Caveat: the DO's `lastSnapshotAt` is refreshed by
the very next post-bring-up session sync (PR1's Storage section: "rides the
existing 300s burn mirror"), so by the time PR4b actually composes and
delivers — which happens after bring-up, possibly several sweep ticks later
— `lastSnapshotAt` may already describe the NEW session's first upload
rather than the one that was restored. PR4b must use the restore-time value
captured at bring-up, never whatever `lastSnapshotAt` happens to read by
delivery time.

**Task-to-branch matching — 3 legitimate sources, ANCHORED match only, never
a bare substring or wildcard like `*<n>*`:**
1. A linked GitHub PR's `headRef`, when the PR is linked to the task via a
   board envelope artifact of shape `{kind: "pr", pr: "150"}` — exactly how
   this studio itself reports progress all day (`apps/fleet/src/board/
   verify.ts` already defines this artifact kind).
2. Envelope artifacts generally: a `{kind: "branch", ...}` artifact, if the
   task recorded one directly (`board/verify.ts` defines this kind too).
3. This fleet's own naming convention: `fleet/rescue/<studio>-<14-digit UTC
   stamp>` (provision.ts's `discoverRescueRefsCmd`, rescue.ts's
   `rescuePushCmd` — re-exported through do.ts — `$(date -u
   +%Y%m%d%H%M%S)`, exactly 14 digits).

Any match must be anchored to the full branch name or a fixed prefix —
never a bare substring or wildcard match.

**Known follow-up (issue #107 re-review, not designed here): a rescue ref
carries no task number.** `fleet/rescue/<studio>-<14-digit UTC stamp>` names
the studio and the moment of the push — it has no slot for a task number by
construction, unlike source 1 (the PR's own linked task) or source 2 (an
explicit `{kind: "branch"}` artifact naming its task). PR4a's composer
(`SurvivalInput`) therefore has no `rescueBranches` section today, and this
spec does not yet say how PR4b would attribute a bare rescue ref to a
specific task — correlating one to the right task needs a real design
decision (by studio + time-window against the task's own assignment history?
by whatever the rescue push's own commit trailer says, if it says anything?),
not a mechanical field addition. Left for PR4b's own design pass rather than
guessed at here.

## Out of scope

- Any actor on the new signals: watchdog, auto-heal, idle-stop, auto-destroy,
  Telegram. Idle-stop and auto-destroy in particular are a SPEND decision and
  the operator's alone; PR3 makes idling visible and stops there. (Exception: PR4b,
  above — a Worker-initiated wake after a detected replacement. Composing and
  delivering a re-brief after that replacement is the point of #107, so it is
  the one deliberate actor authorized here.)
- Container or bring-up edits. Batch them for the next container window:
  - `studio-bringup.sh:578` success line to stderr;
  - log the `--continue` decision (~`:1425`).
- Deadlines on the sync-cycle execs. That changes heal timing; own issue.
- Repair verbs (`recycle`, `provision`, `destroy`) naming the failing side
  the way #92 made `inspect` do. On a DO failure they should say "this
  studio cannot be recycled from the CLI right now" and name the fallback,
  instead of printing `failed`. Own issue, once the shape 5 diagnosis
  names the fallback.
- Push-based session sync from inside the container, which would survive a
  dead exec plane. Own issue.
- #82 and #90.

## Open measurements (implementing studio, before code that depends on them)

- **M2** Does claude 2.1.224 create `~/.claude/projects/<key>` before the
  first message? (PR2)
- **M3** How often does `file changed as we read it` appear in the Worker
  tail? (PR2)
- **M4** Does 2.1.224 hot-reload hooks added to `settings.json`
  mid-session? (PR3b only) If not, running leads get hooks at their next
  launch. Never force a relaunch (#70). **No longer blocks PR3.** PR3's
  recommended pane leg is independent of it — see "M4, and what it changes".
  Measure it during PR3a by appending a no-op hook to a live `settings.json`;
  one exec, no relaunch.
- **M5** Does one hung exec freeze the DO's whole schedule? It would explain
  the wedged studio's zero alarms. Informs the sync-deadline issue.
- **M6** In claude 2.1.224's agent panel, which glyph means a member is still
  running — `◯` or `●`? (PR3) One real sample only (`REAL_WEBSTUDIO_PANE`:
  `● main` and `◯ frontend-developer …`). PR3 deliberately does NOT depend on
  a glyph rule: `WAITING MEMBERS` is decided by the panel rows CHANGING
  between the probe's two captures. Measuring M6 would let a single 30s frame
  answer it too; until then that state is 300s-granular.
- **M7** On healthy running studios, how often does a frame fail
  `footerAtBottom`? (PR3) That is the `?` rate, and it is what decides whether
  the ACTIVITY column is worth reading. Count it in the Worker tail for one
  day during PR3a before anyone relies on the column.
- **M8** When a member finishes CLEANLY (its turn ends normally, no kill),
  does its agent-panel row disappear the same tick-to-tick way a KILLED
  member's row does, or does claude's own UI leave some other trace (a
  different glyph, a "finished" line, a brief terminal state) that a healthy
  finish and a wedge-then-kill do not share? (#311) This is the exact
  measurement the PR3 addendum's "Ask 2" needs before member-death detection
  could ever be widened beyond "corroborated by a same-window memguard kill."
  Until measured, a bare vanished row with no corroborating kill produces NO
  alert at all — see the addendum's own "Confidence, stated plainly"
  paragraph.
- **M9** Over real polling/operator-check cadences, how long does an alert
  need to stay visible to reliably be seen? (#311) `MEMGUARD_ALERT_RETENTION_S`
  (10 minutes) is an unmeasured placeholder, not tuned against any real
  observation interval.
- **M10** What do healthy-but-long member rows (a real, non-wedged vitest/
  build run genuinely taking 20-40+ minutes) look like across this fleet, in
  both elapsed time AND token growth rate? (#311) `POLL_LOOP_ELAPSED_MINUTES`/
  `POLL_LOOP_TOKENS` were picked only to sit below the two wedge incidents
  this issue measured, not validated against any healthy sample — a real
  distribution could show these thresholds flagging routine long runs, or
  missing wedges that idle at a lower token count than 506.3k.

## Delivery

- One studio, `fleetflare--web-studio`.
- PR1, then PR2, then PR3; each its own PR and its own review.
- PR1 needs nothing beyond this spec. PR2 gets an in-chat design first. PR3
  is now designed in full above and splits into PR3a (pane leg) and PR3b
  (hooks, after M4). the operator approved the PR3 design 2026-09-25 (#221).
- **PR4b approved by the operator 2026-09-25** (#249): build proceeds. PR4a (the
  composer) merged as #150.
