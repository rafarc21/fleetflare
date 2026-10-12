# Plan #501 — CLI help text accuracy (F3-F11)

Ref #501 (batched from docs/maintainability/2026-10-12-cli-text-sweep-12.md, ref #481).
Scope: F3-F11 only — operator comment on #501 skips F1-F2 (container/ image change, held).
All edits are help/usage/error STRING wording in `apps/fleet/src/studio/cli-args.ts`,
`apps/fleet/src/studio/ff.ts`, `apps/fleet/cli/ff.ts`. F7 is the only emitted usage-error
string; wording only, parse result unchanged.

## TDD shape

F3-F9, F11 live in VERBS summaries + parser usage strings already covered by
test/studio.cli-args.test.ts (VERBS table pinned? — check; if pinned, tests updated with
the strings). F10 lives in FF_HELP / cli/ff.ts header comment. Steps:

1. RED: update/extend tests asserting the NEW wording (VERBS summaries via whatever
   existing tests read them; new small tests for F6/F7 usage strings; FF_HELP adopt line).
   Run: cd apps/fleet && bun test test/studio.cli-args.test.ts — expect failures.
   Commit RED, push (LEFTHOOK=0 git push -u origin fix-501-cli-help-text-accuracy).
2. GREEN: apply the nine string edits below. Tests pass. Commit, push.
3. Verification: bun test test/studio.cli-args.test.ts; scripts/english-check.ts;
   scripts/test-lies-check.ts; npx tsc --noEmit; npx tsc --noEmit -p test. One at a time
   (memory ceiling).

## Edits (current text found at cli-args.ts as of origin/main 273bc44)

- F3 (:355 VERBS.destroy): `fleet resume` it from its container (after a cooldown)
  → resume it FROM ITS CONTAINER (`fleet resume`, the in-container binary) after a
  cooldown — the Mac CLI's own way to start it again is `fleet provision <id>`.
- F4 (:311 VERBS.ls): add `dead` to lead list; after "limitResetsAt" add `lastLine`
  and `openPrs (only with --prs; absent means no data)`.
- F5 (:331 VERBS.spawn): drop "(maestro, web-studio, release-studio, pilot, scratch)"
  → "(the roles this fleet declares in fleet.json)"; add maestro clause: maestro is
  spawnable from the Mac (the operator edge); ff refuses it (always local, issue #250),
  and `--new` never applies to it (singleton).
- F6 (:582,589): `fleet task assign <n> <role>` → `fleet task assign <n> <role | role--k | studio-id>`
  in both usage() strings.
- F7 (:1079-1084 hold parser): per-pair usage errors: when --until's value fails
  Date.parse → `--until needs a parseable ISO date (got "<value>")`; when a value-taking
  slot holds a flag-looking token or a pair is missing its value, name the flag:
  `--reason needs a text value` for the reason slot. Help line :418 gains "(any order
  after the slot, as intact flag+value pairs)". Parse RESULT unchanged: same accepts,
  same refusals.
- F8 (:355 VERBS.destroy): `unless --discard-unsynced (or --force)` → `unless
  --discard-unsynced (--force passes it too, but also skips the open-task check — the
  refusal lines only ever suggest --discard-unsynced on purpose)`.
- F9 (:347 VERBS.inspect): `the last ~60 pane lines via tmux capture-pane -p` →
  `the last ~60 pane lines via tmux capture-pane -p (the route's default;
  GET /inspect?lines=N overrides — the Mac CLI always sends the default)`.
- F10 (ff.ts:51 + cli/ff.ts:15-18): FF_HELP adopt line appends "(the # is optional)";
  cli/ff.ts header comment form list rewritten to the four forms FF_HELP serves, with
  bare `ff` marked REFUSED (it currently documents the old pre-#250 surface).
- F11 (:411 VERBS.junior): "printing one row per studio/id plus a TOTAL" →
  "printing one row per remote studio plus one per local log id — the same id can
  appear twice (its cloud calls and its laptop-side calls); TOTAL sums both halves".

## Review cap

Operator: 30m review budget, refs only, no closing keywords in commits/comments, no CI
polling. PR after review+QA. No behavior change, no parser change.
