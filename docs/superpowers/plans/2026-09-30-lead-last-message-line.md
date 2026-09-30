# Lead's Last Message Line — `fleet ls --json` (#108, #70 ask 4 remainder)

**Board issue:** https://github.com/rafarc21/fleetflare/issues/108

## Problem

PR #77 added `LsJsonRow` (`apps/fleet/cli/readiness-format.ts`) — one
machine-readable object per studio row in `fleet ls --json`, so a coordinator
can read a studio's state without attaching to its tmux pane. That PR
deliberately left one thing out (see PR #77's own body, and
https://github.com/rafarc21/fleetflare/issues/70#issuecomment-5891651951): the
lead's last VISIBLE message line. Without it, a coordinator reading
`fleet ls --json` can tell WHETHER a lead is working/idle/waiting, but not
roughly WHAT it is doing or saying — that still requires attaching to the
pane. This is that remainder.

## Design

**1. `extractLastVisibleLine` (`apps/fleet/src/studio/activity.ts`).** A pure
function, `frame: string -> string | null`, added alongside `readActivityFrame`
in the same file. It reuses every chrome-detection pattern `readActivityFrame`
already imports from `failover.ts` or defines privately in `activity.ts`
(`footerAtBottom`, `RULE_LINE`, `PROMPT_LINE`, `TURN_ENDED_LINE`,
`MODAL_FOOTER_LINE`, `MODAL_BLOCK_START`, `isCandidateStatusLine`,
`WAITING_MEMBERS_LINE`) rather than reinventing chrome detection: it anchors
to the content above the bottom footer (exactly `readActivityFrame`'s own
`head`), then walks backward from the end skipping every one of those chrome
shapes plus blank lines. The first surviving line, trimmed and bounded to
`LAST_LINE_MAX_CHARS` (200) characters with a trailing `…` when longer, is
the answer. No redaction happens here — this function is deliberately pure,
the same as `readActivityFrame` itself.

**2. `Observed.lastMessageLine` (`apps/fleet/src/studio/observed.ts`).** A new
`string | null` field on the existing `Observed` record, defaulted to `null`
in `emptyObserved()`. It rides `mergeObserved`'s existing read-patch-write
cycle the same way `session`/`lastShipOkAt` already do — it does NOT get its
own DO-storage key the way `activity`/`memberAlerts` do, because it has no
since/anchored state-machine semantics of its own, just "the latest known
value".

**3. Ship-tick wiring (`apps/fleet/src/studio/do.ts`).** Inside
`runShipTickWithObservation`, a new block sits right beside the existing
"member alerts, independent of every branch above" block, gated the same way
(`if (result.paneFrame !== undefined)`): it calls `extractLastVisibleLine` on
the tick's own pane frame, redacts the result with the existing
`redactSecrets` (the same "clean at the write boundary" convention every
other `Observed` field with raw container-echoed text follows), and merges it
in via `mergeObserved`. When `paneFrame` is `undefined` (an old image, or an
exec that never reached the pane section), the field is left untouched —
never reset to `null` — the same "absent means don't touch it" discipline
`paneVerdict`/`hookHeartbeat` already follow at this exact spot. Deliberately
no eager `recordStudioFn` call: this field reaches D1 only via the existing
300s `mirrorBurnToRegistry` cadence (or a transition-triggered
`recordStudioFn` elsewhere in the same function), exactly like `session`/
`lastShipOkAt` already do.

**4. `LsJsonRow.lastLine` (`apps/fleet/cli/readiness-format.ts`).** A new
`string | null` field, added to `LsJsonRow`'s always-present `base` object
(alongside `id`/`repo`/`activity`, since it does not vary by the
running/stopped/limit branching `lsJsonRows` does below it), populated as
`s.observed?.lastMessageLine ?? null`.

## Out of scope

- No new DO-storage key — `lastMessageLine` rides `mergeObserved` exactly like
  `session`/`lastShipOkAt`, never its own key the way `activity`/
  `memberAlerts` are.
- No change to the D1-mirror cadence — no new eager `recordStudioFn` write for
  this field; it reaches D1 exactly as fast (and no faster) as `session`/
  `lastShipOkAt` already do.
- No `container/` changes — `capture-pane` already runs every ship tick;
  nothing about the bring-up script changes.
- No change to the ACTIVITY column, `formatActivity`, or the existing `lead`/
  `leadSince`/`limitResetsAt` fields on `LsJsonRow`.
