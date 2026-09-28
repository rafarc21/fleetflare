# Duplicate attach terminal: root cause + fix (board issue #42)

## The complaint, and the correction that reshaped it

Board #42 opened as "two tmux clients on one studio, the loser's pane
collapses to a one-line status bar — unreadable, not idle." The reporter's
own follow-up comments (in Portuguese, on the issue) narrowed this to what
was actually measured, and that narrowing is what this fix is built against:

- **Defect A** — a genuine SECOND `fleet attach` tmux client on one studio's
  worktree. Confirmed on ONE studio (`web-studio`), one live case.
- **Defect B** — `ensureStudioWorkspace`'s `connected === true` guard is
  satisfied by a PLAIN SHELL an operator (or a leftover reattach) opens in
  the studio's dedicated worktree. The code's own comment called this
  "harmless." It is not: a plain shell satisfying the guard means the REAL
  `fleet attach <id>` terminal is never created at all — a healthy studio's
  sidebar row opens onto a bare shell forever. Confirmed on
  `release-studio`.
- **Defect C** — the same miscount, seen from `fleet tabs`: closing the real
  attach terminal and leaving a plain shell behind makes `tabs` report
  `has one` when the studio actually has none. Confirmed on
  `acme-os--release-studio`.

the operator's own diagnosis, verbatim from the board: count a terminal as the
attach terminal by its COMMAND (`fleet attach <id>`), never by "some
terminal exists in this worktree" and never by `connected` alone. All three
defects close with the same change.

## Root cause, precisely — not just "another guard"

Two separate bugs live in the one `connected === true` check `ensure()` used
(board #6's own fix, itself already a repair of an EARLIER duplicate-tab
bug that keyed on `title === id`, which real Orca's API can never satisfy).

**Root cause of defects B and C: the check counts the wrong thing.**
`terminal list --json`'s measured schema (this file's own header, from board
#6's investigation) has no `command`/argv field — Orca does not expose the
literal command a terminal was created with. The closest available proxy is
`title`, which board #6 already measured reads back as the RUNNING
PROCESS's short name. Since `ensure()` always creates the attach terminal
with `--command "fleet attach <id>"`, that process's name is `"fleet"` —
never `"zsh"`/`"bash"`/whatever shell an operator opens by hand. So
`connected === true` alone (board #6's fix) satisfies on ANY live terminal,
attach or not; `connected === true && title === "fleet"` (this fix) only
satisfies on one actually running a `fleet` command. This is not a literal
command-string match (Orca's schema does not expose one), but it is the
exact, measurable, available proxy for it, and it directly reproduces and
fixes both measured cases: a plain shell's title is its shell, never
`"fleet"`.

**Root cause of defect A: an unguarded check-then-act window, raced by
concurrent CALLERS.** `ensure()`'s idempotency check ("does this studio
already have one?") and its action ("create one") are two separate `orca`
round-trips with an `await` gap between them, and NOTHING before this fix
closed that gap. `fleet` is a Mac CLI — every invocation (`fleet spawn`,
`fleet tabs`, `ff`, `fleet provision`, `fleet recycle`) is its own OS
process, with no shared memory. Grepped every call site that could create an
Orca terminal (`grep -rn 'orca\b\|OrcaRun\|terminal.*create' cli/*.ts`) —
`ensure()` in `cli/orca-workspace.ts` is the ONLY place any of them do, so
candidate "some code path creates a terminal without going through the
check at all" is RULED OUT. Candidate "`connected` reports false while
genuinely attached" is also unsupported — the reporter's own corrected
comment describes the OPPOSITE direction (a plain shell OVER-satisfies
`connected`, it does not under-report it). What remains, and what a
deterministic in-process interleaving test PROVES (see TDD below): two
`ensureStudioWorkspace` calls for the same studio, running concurrently
(e.g. an operator's `fleet spawn` and a scheduled `fleet tabs` a few seconds
apart), can both read "no attach terminal yet" before either one's
`terminal create` has landed, and both then create one. This is a plain
TOCTOU race, and it is real: reproduced with NO artificial timers, just two
`Promise.all`'d calls sharing one stateful fake, confirmed RED against the
pre-fix code (2 `terminal create` calls, not 1) before any fix code was
written.

## The fix, in the issue's own order

### 1. Stop creating the second terminal

Two independent changes, because two independent mechanisms:

**a. `isAttachTerminal`, not `connected` alone.** `ensure()`'s idempotency
check is now `t.connected === true && t.title === "fleet"`
(`ATTACH_TERMINAL_TITLE`). Fixes defects B and C directly: a plain shell no
longer satisfies the guard, so the real attach terminal always gets created
when it is missing, and `fleet tabs` never reports coverage from a shell.

**b. `OrcaDeps.lock` — a per-studio-id critical section, held across
processes.** `ensureStudioWorkspace` now wraps its ENTIRE call into `ensure()`
(not just the terminal half) in `deps.lock(id, () => ensure(id, deps))`.
`defaultOrcaDeps()` wires the real implementation, `fileLock` (built on
`fileLockAt`, parameterized for tests): an exclusive-create (`wx`) lock file
at `~/.fleet/locks/<studio-id>.lock` — same directory convention board #39
uses for `~/.fleet/orca-workspaces.json` (small, local, per-machine,
non-credential Mac-side state). Acquire polls up to `LOCK_WAIT_MS` (60s —
generous, since a legitimate holder may be mid `worktree create`, which
alone can take up to `CREATE_TIMEOUT_MS` = 45s); a lock file older than
`LOCK_STALE_MS` (120s) is treated as abandoned by a crashed holder and
stolen rather than honoured forever. A lock that cannot be acquired within
budget THROWS, which `ensureStudioWorkspace`'s existing single try/catch
already turns into `{kind: "failed"}` — no new failure mode, no hang, same
"never fails its caller" property this file already guarantees.

This is the actual fix for defect A: two `fleet` processes racing each
other now either see the finished result (whichever won the lock ran to
completion, including its `terminal create`, before the other's `ensure()`
body starts at all) or wait their turn — never an interleaved half-read.

### 2. Reconcile what's already out there

`ensure()` itself, right after fetching `terminal list` (every call, not
only `fleet tabs`): filters to `isAttachTerminal` entries. If MORE than one
is found — a duplicate from before this fix shipped, or from the exact race
the lock above now prevents going forward — `rankAttachTerminals` orders
them best-first (not `orphaned`, `writable`, tie-broken by most recent
`lastOutputAt` — all three MEASURED fields from board #6's own schema dump,
never invented) and every terminal but the best is closed via
`terminal close --terminal <handle>` (the same call board #57's
`removeWorkspace` already uses — confirmed, not hypothetical, unlike an
earlier stale comment in this file that claimed no confirmed `terminal
close` existed; corrected in passing). The kept handle plus every closed
one is returned on the outcome (`closedDuplicates`), so every call site
(spawn/provision/recycle/`ff`/`fleet tabs`) self-heals a duplicate it
happens to see, not only the batch `tabs` pass.

### 3. Make a recurrence loud

`TabsReport` gained a `deduped: { id: string; closed: string[] }[]` field,
populated by `reconcileStudioWorkspaces` whenever an outcome carries
`closedDuplicates`. `cmdTabs` (`cli/fleet.ts`) prints one `deduped   <id>
(closed N duplicate attach terminal(s): <handles>)` line per entry — a
recurrence is never folded silently into `opened`/`has one`, the same way a
`skipped` studio already gets its own visible line.

## TDD

Written and run RED against TODAY's (pre-fix) code, confirmed with real
`bun test` output, before any fix code existed:

```
test/bun/orca-workspace.test.ts:
  expect(creates.length).toBe(1);
Expected: 1
Received: 2
(fail) two concurrent ensureStudioWorkspace calls for the same studio create only one attach terminal
```

The trivial "call it twice sequentially" case (board #42's own wording,
first half) was NOT trivially green against pre-fix code either, once
mechanism-accurate: a sequential double-call with a plain-shell fixture
(defect B) also fails pre-fix — the old `connected`-only guard treats the
shell as the existing attach terminal and never creates the real one. Both
halves of the mandated test — "a second call creates none" and "a worktree
carrying two is reconciled to one" — are covered:

- `a plain shell in the worktree does not satisfy idempotency` (defect B)
- `fleet tabs does not report coverage from a plain shell` (defect C)
- `two concurrent ensureStudioWorkspace calls ... create only one attach
  terminal` (defect A's actual mechanism, the race)
- `a worktree already carrying two connected attach terminals is
  reconciled to one` (reconciliation, mandated wording verbatim)
- `duplicate reconciliation prefers the writable, non-orphaned terminal
  over mere recency` (ranking)
- `fleet tabs surfaces a reconciled duplicate loudly, in its own report
  bucket` (loud recurrence)
- Four `fileLockAt` tests against a REAL tmpdir (not the in-memory fake):
  serializes same-id holders, lets different ids run concurrently, steals a
  stale lock, releases on a thrown error.

All confirmed GREEN after the fix (`bun test test/bun/orca-workspace.test.ts`
— 42 pass, 0 fail).

## Coordination with #39 and #57 in the same file

Checked before starting (`gh pr list`, `git log origin/main --
apps/fleet/cli/orca-workspace.ts`):

- **#57** (`fleet destroy` teardown, `removeStudioWorkspace`) is ALREADY
  MERGED to `main` and is an ancestor of this branch. Read in full. Its
  `connected === true`-based terminal-closing in `removeWorkspace` (close
  EVERY connected terminal in a worktree about to be `rm`'d, attach or not)
  is intentionally left untouched — that function's job is "empty this
  worktree entirely before deleting it," which is correctly broader than
  `ensure()`'s "is THIS specifically the attach terminal" question. Not
  regressed; the corrected stale comment (see above) is the only edit made
  near it, and only because this task's own duplicate-close logic is
  right next to it.
- **#39** (`orca-row-task-title`, PR #46) is STILL OPEN, not yet merged, as
  of this work. This branch is built on `origin/main` BEFORE #39 lands, per
  this task's own instruction. Read #39's full diff (`gh pr diff 46`) to
  avoid contradicting its design: it adds a `WorkspaceRegistry` to
  `OrcaDeps`, changes `ensureStudioWorkspace`'s signature to
  `(id, title, deps)`, adds a `worktree set --display-name` call, and
  changes `reconcileStudioWorkspaces`'s signature to take a `titleFor`
  callback. None of that overlaps functionally with this fix (title vs.
  terminal-dedup are orthogonal concerns), but it DOES overlap textually —
  both PRs touch `OrcaDeps`, `ensure()`'s body, `WorkspaceOutcome`,
  `reconcileStudioWorkspaces`'s signature, the `fake()` test helper, and
  `cmdTabs`'s print loop. Whichever of #39/#46 and this PR merges SECOND
  will need a real rebase (not just a mechanical merge) touching those five
  spots — flagged here explicitly rather than silently hoping git resolves
  it. No functional conflict: `OrcaDeps` gains `registry` (theirs) and
  `lock` (this PR) as two independent new required fields; `ensure()` gains
  a registry-based lookup (theirs) and a lock wrapper + dedup pass (this
  PR), at different points in the function; `WorkspaceOutcome`'s variants
  gain unrelated optional fields from each.

## Overlap with board #55 (flagged, not fixed here)

#55's defect B ("attach terminal going orphaned/unwritable while `fleet ls`
reports healthy") and defect C ("attach handles rotating silently, titles
not surviving") are a DIFFERENT failure shape from what this PR fixes —
those are about a single terminal degrading in place, not two terminals
existing. Not fixed here (out of this task's boundary). Two points of real
overlap worth naming for whoever picks up #55:

- The `orphaned`/`writable` fields this PR now reads (for
  `rankAttachTerminals`, to prefer the "genuinely connected AND functional"
  duplicate) are exactly the fields #55's defect B would need to detect an
  orphaned/unwritable terminal in the FIRST place, single or not. The
  measured schema and the field names are now in one place
  (`OrcaTerminalEntry`) if #55's fix wants them.
- #55's own "attach handles rotating silently" (defect C there — a
  different C from THIS issue's defect C) is not something this PR's fix
  touches; the terminal-close calls this PR adds are scoped strictly to
  PROVEN duplicates (`isAttachTerminal` count > 1 on ONE worktree, right
  now), never a rotation/health check over time.

## Monitor rule (empty read = unreadable, never idle)

Neither `cli/orca-workspace.ts` nor `fleet tabs` reads terminal SCREEN
content anywhere — this file only ever calls `worktree`/`terminal`
`list`/`create`/`close`/`rename`, never `terminal read --screen`. Grepped
the repo for that classification logic (`orca terminal read`, `--screen`,
`idle`) — the only place it appears is `skills/fleet-cockpit/SKILL.md`
(a maestro/coordinator SKILL, not code in this repo), which already
distinguishes "footer shows only the bypass-permissions line" as idle by
matching specific screen content. The empty-read-is-unreadable distinction
this issue asks for belongs there, not here — noted for whoever builds that
path in code; this PR does not touch it.

## Boundary

Touched: `apps/fleet/cli/orca-workspace.ts`, `apps/fleet/cli/fleet.ts` (only
`cmdTabs`'s print loop — one new line), `apps/fleet/test/bun/orca-workspace.test.ts`,
`apps/fleet/test/bun/orca-workspace.exit-code.ts` (fixture updated for the
new required `lock` field), this plan doc. Nothing under `src/`, `container/`,
`gates/`, `skills/`, `.github/` touched.

## Verification

`cd apps/fleet && bun run check` — clean (`tsc --noEmit` × 5 project
configs). `bun run bun-test` — 308 pass, 9 skip, 0 fail (up from 304 pass
before this task's new tests). `bun run test` (vitest lane) — 2145 pass,
83 files, 0 fail. Full output captured in the PR/report; none of this run
hit the two known-flaky files (`test/studio.session.test.ts`,
`ego-browser-idle-shutdown*.test.ts`) as failures.

Not verifiable from this container (no real Orca reachable, same limitation
every prior task on this file has documented): whether `terminal list --json`
still reports `title: "fleet"` for a `fleet attach` process specifically
under whatever shell/wrapper actually execs it on the operator's machine (this PR
relies on board #6's own MEASURED claim, not a fresh measurement), and
whether the file lock's `LOCK_WAIT_MS`/`LOCK_STALE_MS` budgets feel right in
practice — both are judgment calls same as this file's existing
`TASK_TITLE_MAX_CHARS`-style constants, easy to retune if the operator reports
either is wrong.
