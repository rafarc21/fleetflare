# Blueprint: push discipline + one-gate-at-a-time (board issue #98)

Fix task, blueprint text only. Two operational rules, both from board
measurements on 2026-09-24, written into Web Studio and Release Studio.

## Rule 1 — push discipline

Measured on #796 (`demosite-life--release-studio`): containers wedged or were
replaced 3 rounds running, each round losing 100% of member work because
nothing had been pushed. The round that ran "each member pushes its RED test
before writing implementation" survived — 2 of 3 tasks already had commits on
origin (`fix-796-t5-affordance-guard-v2`, `fix-796-t6-error-surface`) when the
container wedged; only the task with nothing pushed was lost.

Every Developer now pushes its branch to origin right after the first
RED-test commit, then after every commit after — never more than 15 minutes
of unpushed work. The lead verifies with `git log origin/main..origin/<branch>`
(count commits, never refs — an empty-but-pushed branch would otherwise
silently read as success).

## Rule 2 — one heavy gate at a time

Measured 2026-09-24: 211/212 alarm kills since 09-23 had container memory at
the cap, driven by parallel heavy gates — 3 members on
`demosite-life--release-studio` each ran a multi-minute pre-push gate at once,
hit the 11.65 GiB ceiling, wedged.

Not a parallelism cap — fan-out stays the default. The constraint is
concurrent HEAVY GATES only (full test suite, `vite build`, repo-wide
`tsc`/typecheck, e2e, pre-push hooks): queue or lock around the gate
(`flock /tmp/fleet-gate.lock <gate cmd>`), never cap members to enforce it.
Durable fix is per-exec timeouts + session isolation (#104); this buys time
until then.

## Files touched

- `fleet/blueprint/studios/web-studio/studio.md` — both rules added after the
  dispatch paragraph (lead verifies pushes, coordinates the gate lock across
  Frontend/Backend Developer).
- `fleet/blueprint/studios/release-studio/studio.md` — both rules added after
  the "Failures: write fix-task issues" paragraph, framed for what Release
  Studio actually does: state both rules in every fix-task issue it writes
  (it never implements itself, so it carries the rules forward rather than
  enacting them directly).
- `fleet/blueprint/studios/web-studio/members/backend-developer.md` and
  `frontend-developer.md` — the two code-writing members in Web Studio that
  actually commit and run gates. Code Reviewer (read-only, no Bash) and both
  studios' QA Engineer (browser verification, not a full gate) were left
  untouched — neither commits nor runs a full gate.
- Release Studio has no Developer-type member (`members/qa-engineer.md`
  only) — nothing to touch there.

## TDD / verification

Not behavior — prose in already-parsed blueprint files. Ran the narrow
structural parser test first (would catch broken frontmatter or an empty
body), then the full lanes once at the end.

```
$ bun test test/studio.studio-blueprint.test.ts test/studio.files.test.ts
 23 pass
 0 fail
Ran 23 tests across 2 files.
```

Full lanes, once, from `apps/fleet/` (only agent running, confirmed by lead
before dispatch):

```
$ bun run check
$ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
(exit 0, no diagnostics)

$ bun run test
$ vitest run
 Test Files  86 passed (86)
      Tests  2203 passed (2203)
(exit 0)

$ bun run bun-test
$ bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts
 337 pass
 9 skip
 0 fail
Ran 346 tests across 31 files.
(exit 0)
```

## Boundary

Touched: the 4 blueprint files above, this plan doc, `.fleet/done.json`.

Not touched: `apps/fleet/container/**`, no Worker or CLI code, no
`fleet/blueprint/roles/*.md`, no `maestro/studio.md` (maestro is solo, never
implements, never runs a gate — the rules don't apply). No deploy, no merge.
