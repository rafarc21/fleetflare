# Wake gate: recognize the permission-prompt footer too (#144)

**Goal:** `runGatedWake`'s LOOSE screen check (`wake.ts`) must refuse typing
into an ordinary Claude Code permission prompt ("Do you want to proceed? /
❯ 1. Yes / 2. No"), not just the limit/select modal it already catches.

## Bug

`LOOSE_LIMIT_PATTERNS` only recognizes the limit modal's own footer row,
`Enter to confirm · Esc to cancel`. Claude draws a DIFFERENT footer for a
plain permission prompt: `Esc to cancel · Tab to amend · ctrl+e to explain`.
That exact string is already known to the strict detector as
`MODAL_FOOTER_LINE` (`failover.ts:279`, added for the strict detector's own
permission-prompt handling) but was never added to the loose gate's patterns.

Consequence: a permission prompt on screen is invisible to both gates (the
strict detector's `bottomLimitModal` only fires on "Stop and wait for limit
to reset" wording, so it falls through to `working`; the loose gate only knew
the limit modal's footer). `runGatedWake` types the wake prompt into the
composer and presses Enter — a digit anywhere in the wake text (e.g. a task
number like "144") typed into a live "❯ 1. Yes / 2. No" prompt can select a
numbered option: an unattended approve/deny of a tool call.

## Fix

Add the exact permission-prompt footer string as a second whole-row
alternative in `LOOSE_LIMIT_PATTERNS`, anchored with the same `ROW_LEAD`/
`ROW_TAIL` the existing entries use (so the #144/#141 row-anchoring
invariants — no mid-row match, no trailing-prose match, no ghost-composer
match — hold for this new entry exactly as they do for the others):

```
`${ROW_LEAD}Esc to cancel · Tab to amend · ctrl\+e to explain${ROW_TAIL}`,
```

This mirrors `failover.ts`'s own `MODAL_FOOTER_LINE`, which already hardcodes
both known footer strings as alternatives rather than a generic substring
match, and the same `ctrl\+e` escaping (the `+` is literal, not "one or
more").

## Test

`test/studio.wake-race.test.ts`, `describe("gate 3 is LOOSE: ...")`: a new
`UNSEEN` case using the existing `REAL_PERMISSION_PROMPT_TAIL_PANE` fixture
(`test/fixtures/activity-panes.ts:247`) as the screen. Asserts `runGatedWake`
returns `ok: false`, `skipped` undefined (loose-only refusal is loud, per the
#141 review), and `cmds` equals exactly `[PANE_PROBE_CMD, PANE_SCREEN_CMD]` —
zero send-keys, nothing typed. RED before the `LOOSE_LIMIT_PATTERNS` change
(lands as `ok: true`, 3 cmds today), GREEN after.

No behavior change to the existing pinned #141/#144 anchor tests: the new
pattern is a whole-row exact-literal alternative, so it does not affect rows
carrying "Esc to cancel" as a substring with different trailing text, nor
mid-row/ghost-composer cases.
