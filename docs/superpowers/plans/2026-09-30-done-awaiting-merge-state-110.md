# Board task #110 ("done-awaiting-merge task state") duplicates a `won't-do` verdict already recorded on parent issue #70

## Conflict found (no code bug here — this is a scope/triage conflict, not a defect)

Board task [#110](https://github.com/rafarc21/fleetflare/issues/110) asks to
implement "done-awaiting-merge task state" — ask 6 from parent issue #70.
As filed, it asks for:

- a new board/task state meaning "lead finished + reported, PR open, waiting
  merge"
- board vocabulary changes
- `fleet ls` filter changes
- reap-rule changes
- docs

Parent issue #70 already triaged this exact ask one day before #110 was
opened. #70's own triage comment
([2026-09-29T13:49:55Z](https://github.com/rafarc21/fleetflare/issues/70#issuecomment-5891651951))
verdicts ask 6 explicitly:

> 6 | Done-awaiting-merge state | **won't-do (for now)** | Follow-ups now
> `task new --continues <n>` (#71); terminal states close issues (#55); reap
> covers idle (#53/#61). New state = board vocabulary change.

So #110 asks for exactly what #70 already rejected, for the same stated
reason (a new board state is a board-vocabulary change, judged out of scope
for now) — not a new requirement, not new information, just the same ask
re-filed as a standalone board task after the parent issue had already
closed it out as won't-do.

This conflict was posted as a blocker comment on #110:
[https://github.com/rafarc21/fleetflare/issues/110#issuecomment-5912382442](https://github.com/rafarc21/fleetflare/issues/110#issuecomment-5912382442)

## Decision

No implementation. #110 is superseded by #70's `won't-do (for now)` verdict
for ask 6. The existing mechanisms #70 names as covering the underlying
need remain in place and unchanged:

- follow-up work is tracked via `task new --continues <n>` (#71)
- terminal task states already close their issues (#55)
- idle/stale studios are already handled by the reap sweep (#53/#61)

If the need for a distinct "done-awaiting-merge" board state resurfaces, it
should be re-opened against #70 (or a fresh issue that supersedes both #70's
verdict and this record) with new justification for revisiting the
won't-do call, not re-implemented silently as a side effect of #110.

## No code touched

This is a decision record only. No board/task-state code, no `fleet ls`
filter code, no reap-rule code, and no other application code was changed
as part of this task. The only file added by this task is this plan doc
itself.

## Verification

Nothing to verify behaviorally (no code changed). Confirmed the repo's
standard gate suite still passes untouched, from `apps/fleet/`:

```
$ bun run english-check
$ bun run check
$ bun run test
```

(See the completion record for real exit codes and tail output.)

## Boundary

Touched: this plan doc only
(`docs/superpowers/plans/2026-09-30-done-awaiting-merge-state-110.md`).

Not touched: any CLI/board/task-state code, `fleet ls` filtering, reap
rules, or docs describing them — none of that was implemented, per the
decision above. No deploy.
