# Wake gate: recognize the select modal's opener, not just its footer (#146)

**Goal:** `runGatedWake`'s LOOSE screen check (`wake.ts`) must refuse typing
into a select-style modal (permission prompt, limit modal, plan-mode choice)
even when claude draws a footer the gate has never seen, not just the two
exact footer literals `LOOSE_LIMIT_PATTERNS` already knows.

## Bug

`#144` added the permission prompt's exact footer string, `Esc to cancel ·
Tab to amend · ctrl+e to explain`, as a second literal alternative next to the
limit modal's own `Enter to confirm · Esc to cancel`. Both are exact-literal
matches. A future Claude Code version that rewords either footer reopens the
hole `#136`/`#144` closed: the strict detector (`failover.ts`) does not
recognize the new wording either (it keys off `MODAL_FOOTER_LINE`, the same
two literals), so the wake gate sees a "working" screen and types the wake
text into a live select modal. A digit in the wake text (a task number like
"146") can pick a numbered option — unattended spend, unattended
approve/deny.

## Design decision — generalize on the modal's OPENER, not a bare numbered row

The obvious-looking fix is a bare "numbered option row" pattern — something
shaped like `❯\s*[0-9]+\.` — added to `LOOSE_LIMIT_PATTERNS` so any row that
*looks like* `❯ 1. Yes` refuses regardless of what footer follows it. This
was considered and rejected:

1. **It breaks a pinned test.** `test/studio.wake-race.test.ts`'s "gate 3
   loose check anchors on modal ROWS (#141 review)" describe block pins that
   the ghost-composer row `"❯ 1. Upgrade deps"` — claude's own suggestion
   text drawn in an EMPTY composer, not a modal — must NOT refuse
   (`outcome.ok === true`). A bare numbered-row pattern matches that string
   whole-row and would refuse it, breaking the pin.
2. **It reopens an already-fixed false-positive class.** PR #102's first cut
   at the strict detector matched "a numbered list of the options" as a
   substring anywhere on screen, and `test/fixtures/rate-limit-panes.ts`'s
   `NOT_DETECTED` corpus exists specifically to pin that this must never
   happen again: fixtures (d)/(e)/(f)/(g) are measured/reconstructed cases of
   a LEAD'S OWN PROSE containing a numbered list (a status update, a plan, a
   checklist — "1. Stop and wait" / "2. Add funds" / "3. Upgrade") that is
   NOT a modal. Several of these sit well within `LOOSE_TAIL_LINES` (12) of
   the bottom of their pane. A bare numbered-row pattern would refuse every
   wake sent while a lead's own numbered plan is still in the tail window —
   exactly the trap this codebase already paid to close once.

The fix instead generalizes on the part of the dialog that is ACTUALLY
footer-wording-independent and structurally safe: the modal's OPENER.

- `▔` (U+2594) repeated is the top rule claude draws for EVERY select-style
  menu (limit modal, permission prompt, plan-mode choice) — already
  established in this exact codebase: `failover.ts`'s `MODAL_BLOCK_START`
  comment states it is reused "so activity.ts can recognise ANY select-style
  menu drawn in this same ▔-ruled shape … without forking this regex or
  hardcoding the limit modal's own question text." No lead's own prose ever
  prints a bare row of repeated ▔ box-drawing characters — it is a UI-only
  glyph, not something a human or a lead types. Zero hits in the `NOT_DETECTED`
  corpus or any pinned "the wake lands" row.
- `"Do you want to proceed?"` — the literal question text of an ordinary
  permission prompt, named explicitly in issue #146. Zero hits in the
  `NOT_DETECTED` corpus or any pinned "the wake lands" row.

`"What do you want to do?"` (the limit modal's own opener, also already part
of `MODAL_BLOCK_START`) was considered for symmetry but NOT added: the
`NOT_DETECTED` corpus's fixture (h) ("V1's modal quoted in prose, then more
output") contains that exact line, and while that fixture is the STRICT
detector's trap case rather than the loose gate's, adding the opener as a
loose-gate whole-row pattern was not worth the risk for a phrase the two
entries above already make redundant (a `▔` rule always opens the same
modal). Dropped rather than risk a false positive that would silently block
every later wake on an idle screen (#141 review's own stated cost of a loose
false positive).

Both new entries reuse the array's existing `ROW_LEAD`/`ROW_TAIL` anchors
(row-only, `(│)?` bound to a GROUP never to a byte, no `\s`/`\b`/`{n,}`), the
same discipline every other entry in `LOOSE_LIMIT_PATTERNS` already follows.
Because `LOOSE_LIMIT_PATTERNS` is the ONE array that feeds both the JS-side
check (`looseLimitOnScreen`) and the shell-embedded `grep -E` inside
`wakeCmd`'s `scan` function, adding entries to it is the WHOLE fix — no
separate shell logic, no restructuring `looseLimitOnScreen` into something
stateful or multi-line. This mirrors exactly how #144 landed its own fix.

## Fix

```
`${ROW_LEAD}▔+${ROW_TAIL}`,
`${ROW_LEAD}Do you want to proceed\\?${ROW_TAIL}`,
```

(`\\?` — a JS STRING literal escaping a literal `?` for both `grep -E` and
`new RegExp`, same discipline the file's own doc comment already states for
`ctrl\\+e`.)

## Test

1. New fixture `REAL_PERMISSION_PROMPT_UNKNOWN_FOOTER_PANE`
   (`test/fixtures/activity-panes.ts`) — `REAL_PERMISSION_PROMPT_TAIL_PANE`
   with only its last line (the footer) swapped for a plausible reworded one
   that is not any string in `LOOSE_LIMIT_PATTERNS` or `MODAL_FOOTER_LINE`:
   `"Esc dismiss · Enter approve"`. Same `▔` rule, same "Do you want to
   proceed?" question, same numbered options — the #146 regression case.
2. `test/studio.wake-race.test.ts`'s `UNSEEN` array (describe("gate 3 is
   LOOSE …")): a new case using that fixture. Asserts `outcome.ok === false`,
   `outcome.skipped === undefined` (loud, #141 review), `cmds` equals exactly
   `[PANE_PROBE_CMD, PANE_SCREEN_CMD]` — zero send-keys.
3. `test/bun/wake-guard.test.ts`'s `UNSEEN` array: the same fixture run
   through the REAL emitted `wakeCmd` shell against a fake tmux. Asserts zero
   `send-keys` calls and `__FLEET_WAKE__ refused-before modal` in stdout —
   proving the in-container `grep -E` guard refuses it too, not just the JS
   side.

RED before the `LOOSE_LIMIT_PATTERNS` change (lands as `ok: true` / `sent`),
GREEN after. No behavior change to the existing pinned #141/#144 anchor
tests: the new patterns are whole-row literal alternatives that no
`NOT_DETECTED` fixture, ghost-composer row or MID_ROW/TRAILING case contains.
