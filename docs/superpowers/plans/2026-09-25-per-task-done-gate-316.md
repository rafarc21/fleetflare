# Per-task completion gate record (board issue #316)

Fix task. `.fleet/done.json` was ONE shared file every studio/task
overwrote — whichever task's plan-pointer + verification array landed last
won, clobbering the previous task's record. Measured today: a real merge
conflict on PR #286, near-every PR rewriting it, multiple studios
accidentally pushing it straight to main mid-task (`d73e5c42`, `c78549b0`),
and a whole follow-up PR (#315) that existed only to fix its contents after a
schema violation. This is a repeatedly-measured pain point, not a
hypothetical.

## Design

**Per-task gate file**: `.fleet/done/<task>.json` — one file per task, named
after the issue it closes (e.g. `.fleet/done/258.json`). Two tasks' own
records never share a path, so two PRs each adding their own file merge with
zero git conflicts by construction — this is the whole point, and nothing
new (no index/manifest listing all done-files) was added that would
reintroduce the same shared-mutable-file problem.

**Reader (gates/completion-gate.sh)** — first version, SUPERSEDED by "Task-keyed" below: scans `.fleet/done/*.json` and reads
the **newest** file by mtime — not "any file that validates". Reasoning:
this gate speaks for the task being closed *right now*. If it picked "any
file that validates", a stray older file (quite possibly evidence of a
DIFFERENT, already-merged task) could silently satisfy the gate while the
current task's own record is missing or broken — the opposite of "prove
THIS deliverable is done". Picking the newest file and validating only that
one means a broken current record is reported honestly (named by its own
filename in every refusal message), never papered over by a sibling.

**Task-keyed (PR #325 review, supersedes "newest").** "Newest record" —
on disk, or even among the branch's own — cannot tell which task is
closing: a task with NO record passed on a merged sibling, an invalid
legacy file passed beside one, and the harvest read an old task after a
clone (mtimes follow checkout order). Now:

- Gate resolves the closing task: `FLEET_TASK` env when set; else the one
  `.fleet/done/<task>.json` this branch wrote (uncommitted/untracked, or
  changed since merge-base(HEAD, origin/main)); several → the one the branch
  name carries; none → the single issue number in the branch name. Then it
  demands exactly `.fleet/done/<task>.json` and refuses loud naming it when
  absent. Unknown task → refuses "cannot tell which task", never guesses.
- Legacy `.fleet/done.json` counts only when this branch wrote it and wrote
  no per-task record — a stale copy from main never passes.
- Harvest (`harvestRecordCmd`, now pure module `harvest-record.ts` so a bun
  test executes it) reads exactly the delivered task's file
  (`deliveredTaskIn(storage)`), legacy only under the same branch-wrote-it
  rule, else "no record".
- Mutants that turn tests red: gate picks newest on disk; legacy ignored
  when the dir is non-empty; harvest `ls -t`; harvest reads legacy always.

No env var (`FLEET_TASK_ID`-style) was wired from the Worker end to end (the gate honors `FLEET_TASK` when set) to let the gate
target an exact issue number. Considered (Option B in the brief) but
rejected: `STUDIO_ID` is the studio's own id, not a task/issue number, so
adding a NEW env var would need wiring through do.ts → the container's
process env → the hook — real effort for the same practical outcome
"newest file" already gets, since a studio only ever has one task open at a
time in the working tree. Not pursued as over-engineering for this scope.

**Legacy fallback**: when `.fleet/done` has no `*.json` files at all, the
gate reads the legacy shared `.fleet/done.json` exactly as before, for one
release — an in-flight PR from a task not yet updated to the new convention
must not suddenly find its completion refused.

**Harvest (do.ts's `harvestRecordCmd`/`harvestLearnings`)** — first version, SUPERSEDED by "Task-keyed" above: same
preference order — `ls -t .fleet/done/*.json | head -n1`, cat'd if present,
else the legacy path, else `HARVEST_NO_RECORD`. One opaque shell command,
same as before; `harvestLearnings`'s own JSON-parsing and `learnings` field
validation (via `board/envelope.ts`'s `parseLearnings`) is unchanged.

**Migration**: origin/main's current `.fleet/done.json` reflects issue #250
(`docs/superpowers/plans/2026-09-25-keeper-restore-age-250.md`). Copied
verbatim into `.fleet/done/250.json`. The legacy `.fleet/done.json` is left
in place, unchanged and now intentionally stale — a "no worse than before"
migration that also doubles as the fallback path's own fixture (case (b) in
Verification below exercises exactly this state). It is not resynced going
forward; that resync is the exact clobbering behavior this task removes.

This task's own gate record is `.fleet/done/316.json` (this task never
touches `.fleet/done.json`, demonstrating the new convention it introduces).

## Files touched

- `gates/completion-gate.sh` — `RECORD` (a single path) replaced by
  `RECORD_DIR` (`.fleet/done`) + `LEGACY_RECORD` (`.fleet/done.json`); a
  `newest_task_record()` helper picks the newest `*.json` under the dir;
  every refusal message now names the actual file (`record_label`) it
  validated, or explicitly names both candidate locations when neither
  exists. HOWTO text rewritten to teach the per-task convention, with the
  legacy path named as a one-release fallback.
- `apps/fleet/src/studio/do.ts` — `harvestRecordCmd` now prefers
  `.fleet/done/*.json` (newest by `ls -t`) before falling back to the legacy
  path; doc comments on `harvestLearnings`/`HarvestResult` updated to
  describe both locations.
- `apps/fleet/src/board/envelope.ts` — doc comment on `parseLearnings`
  updated to name both the per-task and legacy paths it is cross-referenced
  from.
- `fleet/blueprint/studios/web-studio/studio.md` — house rules paragraph
  rewritten: the Stop hook now names `.fleet/done/<task>.json` as the
  primary record, with the legacy shared file named explicitly as a
  one-release fallback.
- `apps/fleet/test/bun/bringup-hooks.test.ts` — RED-then-GREEN coverage for
  the gate's new directory-scanning behavior (see Verification).
- `apps/fleet/test/studio.session.test.ts` — RED-then-GREEN coverage for
  `harvestRecordCmd`'s new shell shape.
- `.fleet/done/250.json` (new) — migrated content of the legacy record.
- `.fleet/done/316.json` (new) — this task's own gate-satisfying record.
- This plan doc.

Untouched deliberately: `skills/` — grepped the whole directory (including
`skills/fleet-cockpit/SKILL.md` by name, plus every other `SKILL.md`) for
`done.json`, `completion-gate`, "completion gate", and "Stop hook"; no skill
document names the completion gate's record path or shape, so there was
nothing there to update. `apps/fleet/src/studio/provision.ts`'s own doc
comment quoting `.fleet/done.json` (line ~733) is left as-is — it is
historical prose about a *different*, already-shipped feature's own
completion record at the time it landed, not a live description of the
gate's current mechanism. The `docs/superpowers/plans/*.md` files that
mention `.fleet/done.json` are past tasks' own historical plan docs and are
untouched for the same reason.

## Verification

RED-then-GREEN, `apps/fleet/test/bun/bringup-hooks.test.ts` (exercises the
real `gates/completion-gate.sh` bytes via `runSnippet`, real bash + python3,
real git checkouts):

- (a) two different `.fleet/done/<n>.json` files, both valid → gate passes.
- (b) only the legacy `.fleet/done.json` present, no per-task dir → gate
  still passes exactly as before (regression pin).
- (c) neither exists → refuses, naming `.fleet/done/<task>.json` explicitly.
- (d) newest-file semantics: an older, already-valid per-task file sitting
  beside a newer, broken one → gate refuses on the NEWEST file's own
  problems (named by its own filename in the refusal), never silently
  passing because of the older sibling.
- a per-task dir that exists but is empty falls back to the legacy file
  rather than refusing outright.
- **the maestro's own acceptance test**: two real git branches, each adding
  only its own `.fleet/done/<n>.json`, merged into a common base in BOTH
  orders — `git merge --no-ff` exits 0 both times, both files land intact,
  `git status --porcelain` is empty. Real git operations, not an assertion
  about file identity.

`apps/fleet/test/studio.session.test.ts`: `harvestRecordCmd` now asserted to
reference `.fleet/done/*.json` + `ls -t` (new) alongside its existing legacy
substring assertions (kept, still true of the combined command string).

- `cd apps/fleet && bun run check` — clean.
- `cd apps/fleet && bun x vitest run` — full suite green.
- `cd apps/fleet && bun run bun-test` — includes the new/changed
  `bringup-hooks.test.ts` coverage above.
- `bun run apps/fleet/scripts/english-check.ts` — clean.
