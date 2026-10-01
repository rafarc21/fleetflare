# Merge Danger on every studio PR, and in the result envelope (issue #160)

Board issue #160: "Add Merge Danger to every studio PR and to the
`intent: result` envelope." Depends on #161 (done, merged — the deterministic
path classifier, `apps/fleet/scripts/merge-danger.ts`). Reassignment comment
on #160 widened the scope: extend `ONE_WAY_GLOBS` with 4 more files +
`gates/**`, and (attempt to) wire merge-danger as a CI check/label — the
latter hits the same hard blocker #161 already hit (see Part F).

Six parts, lettered to match the task brief.

## Part A — `.github/pull_request_template.md` (new)

Not under `.github/workflows/`, so it pushes fine (the workflow-scope token
restriction only blocks `.github/workflows/**`, confirmed in #161's plan).
Three sections: Summary, Evidence, Merge Danger (Door one-way|two-way, Blast
Radius one line). Minimal — a template an agent or human fills in, not prose
to read standalone, same terse voice as `docs/operations.md`.

## Part B — `fleet/blueprint/studios/web-studio/studio.md`

Grep confirmed only this file has the "open the PR yourself" line (around
line 36) — `release-studio/studio.md` and `maestro/studio.md` have a
different PR-opening model, so this edit is scoped to web-studio only.

Add a rule, right after that line: every PR body uses the
Summary/Evidence/Merge Danger structure from the new PR template (referenced,
not duplicated). Door is `one-way` if the diff touches any
`ONE_WAY_GLOBS` path in `apps/fleet/scripts/merge-danger.ts` (confirmed
automatically once CI is wired, see Part F) OR if the lead's own judgment
says one-way even with no path match — the classifier is a floor, never a
ceiling: it can force one-way, never downgrade a lead's one-way call to
two-way. Blast Radius: one line, what breaks and for whom if this is wrong.

## Part C — envelope schema

`apps/fleet/src/board/types.ts`:
- `MERGE_DANGER_DOORS = ["one-way", "two-way"] as const` + `MergeDangerDoor`
  type, same pattern as `ENVELOPE_INTENTS`/`EnvelopeIntent`.
- `MergeDanger { door: MergeDangerDoor; blast_radius: string }`.
- `EnvelopeDoc['payload'].merge_danger?: MergeDanger` — placed FIRST among
  payload's optional fields, immediately before `verification?` (right after
  `evidence`), per #160's explicit "optional `merge_danger` first" wording —
  the field is meant to be the first thing an operator's eye hits.

`apps/fleet/src/board/envelope.ts`:
- `mergeDanger()` validator, same shape as the existing `verification()`:
  object with `door` checked against the closed set (`MERGE_DANGER_DOORS`,
  same `.includes(...)` pattern as `ENVELOPE_INTENTS` elsewhere in this
  file) and `blast_radius` as a non-empty trimmed string.
- Wired into `parseEnvelope`: validated and attached when `body.merge_danger`
  is present. ALWAYS optional, for every intent including `"result"` —
  unlike `verification`, which becomes required on `intent: "result"`. #160
  says "optional" explicitly; this stays optional on purpose, so it never
  becomes a second gate a studio can get wedged on.
- `renderEnvelopeComment`: a `mergeDangerBlock`, same pattern as
  `verificationBlock` (omitted entirely when absent), but placed FIRST in
  the rendered body — right after the `**intent** from ... status **...**`
  header line, before Artifacts — since the whole point (#160: "route
  operator attention to one-way doors only") is a human scanning the comment
  sees Door/Blast-Radius before anything else.

## Part D — backward-compat + new-field tests

`apps/fleet/test/board.envelope.test.ts`:
- A fixture built from a REAL envelope already posted to the live board
  proves `parseEnvelopeComment` still parses it cleanly, with
  `payload.merge_danger` undefined. Guards against the optional field
  retroactively breaking anything already stored on the board. Deviation
  from the original issue #158 pointer: #158's own two envelope comments
  (checked both, `gh api repos/rafarc21/fleetflare/issues/158/comments`)
  are MISSING `envelope.msg_id` entirely — `decodeDoc` in `envelope.ts`
  requires it as a string and returns null for anything without one, so
  neither #158 comment round-trips through `parseEnvelopeComment` at all,
  for reasons wholly unrelated to `merge_danger` (likely hand-posted via
  `gh issue comment` rather than through the Worker's own envelope route,
  which is the only thing that stamps `msg_id`). Used issue #163's envelope
  instead (`gh api repos/rafarc21/fleetflare/issues/163/comments`,
  comment id 5930494303) — same "before `merge_danger` existed" property,
  but carries a real `msg_id`, so it actually decodes and the "still a
  valid doc, `merge_danger` undefined" assertion is literal, not
  reinterpreted.
- Round-trip test: a valid `merge_danger` survives
  `parseEnvelope`/`renderEnvelopeComment`/`parseEnvelopeComment`.
- Invalid `door` (outside the closed set) is refused with a message naming
  the field.
- Missing/empty `blast_radius` is refused.
- `merge_danger` absent is accepted on every intent, including `"result"` —
  the point being it must NOT behave like `verification` (required on
  result).

## Part E — `fleet/blueprint/studios/maestro/studio.md`

The `🔀 PRS` line in "Every wave, these nine fields, in this order" gains a
`door` field between `mergeability` and `action taken`. Pure prose — no code
renders this line; Maestro (the agent) types it each wave from live
board/PR state.

## Part F — extend `ONE_WAY_GLOBS`, attempt CI wiring (known blocker)

5 new entries added to `ONE_WAY_GLOBS` in `apps/fleet/scripts/merge-danger.ts`
(TDD: tests first in `apps/fleet/test/bun/merge-danger.test.ts`, RED, then
GREEN), all four named files plus `gates/` confirmed present before writing
tests:

| Pattern | Why |
|---|---|
| `apps/fleet/src/studio/do.ts` | the studio Durable Object — core per-studio state machine |
| `apps/fleet/src/studio/wake.ts` | wakes a studio's Claude Code session; a bug here can stall or double-fire across the fleet |
| `apps/fleet/src/studio/registry.ts` | the studio registry — the fleet's source of truth for what's running |
| `apps/fleet/src/studio/profile.ts` | studio account/profile assignment |
| `gates/**` | the hook scripts gating lead writes, completion, and session recovery (lead-gate.sh, completion-gate.sh, etc.) — this IS the safety mechanism these rules describe |

**CI check/label wiring — confirmed blocked, same as #161.**
`.github/workflows/one-way-door.yml` still does not exist on `main`
(confirmed: only `english-check.yml` and `fleet-check.yml` exist in
`.github/workflows/` on origin/main). This container's token cannot write
under `.github/workflows/**` — GitHub rejects it outright ("refusing to
allow a Personal Access Token to create or update workflow ... without
workflow scope"), a hard platform restriction, not a bug. Not re-attempted.

The full intended YAML is already preserved verbatim in
[`docs/superpowers/plans/2026-10-01-merge-danger-161.md`](2026-10-01-merge-danger-161.md)
under "Blocked: workflow file". Confirmed it needs NO changes for #160's
`ONE_WAY_GLOBS` additions: the workflow's "Classify changed files" step pipes
`git diff --name-only <base> <head>` straight into `bun run
apps/fleet/scripts/merge-danger.ts` and reads the JSON verdict back — the
glob table is read live from `merge-danger.ts` at run time, never hardcoded
into the YAML. Once a maintainer with a `workflow`-scoped credential adds
the preserved YAML by hand, it automatically covers these 5 new globs with
zero further edits.

## Files touched

- `docs/superpowers/plans/2026-10-01-merge-danger-pr-block-160.md` (this file)
- `.github/pull_request_template.md` (new)
- `fleet/blueprint/studios/web-studio/studio.md` — PR-body rule
- `fleet/blueprint/studios/maestro/studio.md` — `🔀 PRS` line gains `door`
- `apps/fleet/src/board/types.ts` — `MergeDanger`, `MergeDangerDoor`,
  `EnvelopeDoc.payload.merge_danger`
- `apps/fleet/src/board/envelope.ts` — `mergeDanger()` validator, wired into
  `parseEnvelope`/`renderEnvelopeComment`
- `apps/fleet/test/board.envelope.test.ts` — backward-compat fixture test +
  new-field unit tests
- `apps/fleet/test/fixtures/envelope-comment-issue-163.ts` (new) — the real
  stored-comment fixture
- `apps/fleet/scripts/merge-danger.ts` — 5 new `ONE_WAY_GLOBS` entries
- `apps/fleet/test/bun/merge-danger.test.ts` — one test per new glob class

## Verification

All from `apps/fleet/`, one at a time (no parallel gates):

- `bun run check`
- `bun run test` (vitest — where `board.envelope.test.ts` lives)
- `bun run english-check`
- `bun test test/bun/merge-danger.test.ts` (isolated — `bun run bun-test` is
  known-flaky under host load, tracked at #159; one full attempt is enough
  due diligence once the isolated file is green)

## Still blocked

Same as #161: `.github/workflows/one-way-door.yml` cannot be pushed from
this container. A maintainer with a `workflow`-scoped credential needs to
add it by hand from the YAML preserved in the #161 plan doc — no changes
needed to that YAML for this task's `ONE_WAY_GLOBS` additions.
