# dead-account failover: "organization has disabled Claude subscription access" (board issue #141)

## The gap, as measured

Some claude accounts answer every prompt with one inline line, then return to
claude's own idle input box exactly like an "out of usage credits" block does:

```
  ⎿  Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead
```

`failover.ts` has no detector for this at all today. It is not a select-style
modal (no numbered options, no `Enter to confirm · Esc to cancel` footer) —
`orgLimitModal`/`bottomLimitModal` never match it. It is also not one of
`INLINE_LIMIT_HEADLINES`'s four shapes: every one of those carries EITHER a
`RESETS`-parseable reset clause OR a `/upgrade|/usage-credits|/login`-style
hint row underneath its headline (`inlineLimitBlock`'s own doc comment); this
message has neither. It is one self-contained sentence claude prints once and
never varies. So today an account stuck in this state is invisible to
`nextClaudeAccount` — never marked, never excluded, never surfaced in
`fleet ls` — and a studio can sit on it forever, or a fresh failover can land
a DIFFERENT studio onto it right after the one that just left.

Crucially, this is not a rate limit: nothing about it ever resets. The org
disabled the whole account's subscription access; it stays disabled until a
human (outside this fleet, in the Anthropic console) re-enables it or the
account is retired.

## Why this needs its own `dead` flag, not the existing null-until path

`accounts.ts`'s `AccountLimitEntry`/`accountIsFree` already has a shape for
"a limit was seen with no readable reset" — `until: null` — but review round 1
of #102 (`accounts.ts`'s own `NULL_UNTIL_CEILING_MS` doc comment) deliberately
gave that shape a 24h staleness ceiling: past it, the account is treated as
free again, so the fleet keeps re-probing a `null`-until sighting (typically a
SELECT-style modal, which DOES sometimes clear on its own) rather than
blacklisting it forever. That ceiling is exactly wrong for this message: an
org-disabled account does not clear itself in 24h, in a week, or ever, without
a human acting outside this fleet. Reusing `until: null` for this case would
silently re-admit the account into rotation a day later and hand a studio
right back onto it. So `AccountLimitEntry`/`AccountLimitState` each grow one
new, independent field, `dead?: true`, that `accountIsFree` checks FIRST,
before it ever looks at `until`/`seenAt` — no clock, no ceiling, no
`seenAt`-driven expiry. The only way a dead account becomes eligible again is
a human clearing the fleet_state row by hand.

## Mechanism: reuse the exhausted/switch pipeline via `verdict.inline`

`failover.ts` already has a fully-worked, heavily-tested pipeline for "this
account cannot be used": `PaneVerdict { kind: "modal", inline: true, ... }` →
`limitObservation` builds a `RateLimitObservation` → `runAccountFailover`
writes it fleet-wide (`deps.accountLimits.write`) → `nextClaudeAccount`
(through `accounts.ts`'s single `accountIsFree` choke point) skips the
account on every studio's next tick → `fleet ls`/`--json` render it. This
feature adds nothing parallel to that pipeline. It adds:

1. A new, fully independent detector, `deadAccountBlock`, with the SAME
   anti-false-positive discipline every other detector in this file already
   has (bottom-of-pane anchoring via `lastLineMatching` + a REQUIRED idle
   input box via `endsInIdleInputBox`, `⎿` transcript-glyph requirement) —
   but no `RESETS`/hint-line grammar at all, because the message has neither.
   Deliberately NOT folded into `inlineLimitBlock`/`INLINE_LIMIT_HEADLINES`:
   that machinery's `block()` closure requires either a hint line or a
   hint-less `RESETS` match to accept a candidate, and this message satisfies
   neither.
2. The verdict it returns sets `inline: true`, exactly like every other
   inline block — so it automatically inherits, with ZERO further changes to
   `runAccountFailover`, the redraw guard, the no-flapping guard, and —
   critically — the auto-continue gate, which is keyed off `!verdict.inline`
   (a dead account is therefore NEVER auto-continue-Esc'd, since it was never
   a select modal in the first place).
3. `limitObservation` threads a `dead` flag from the verdict into the
   `RateLimitObservation` it returns, and `FailoverDeps.accountLimits.write`
   grows an optional 4th parameter carrying it through to the D1 row
   (`writeFleetAccountLimit`/`encodeAccountLimitState`). `accountIsFree`
   checks `dead` unconditionally, so `nextClaudeAccount`/`firstFreeAccount`/
   `nextBorrowedAccount` — which all funnel through it — skip a dead account
   without any change to those three functions themselves.
4. `fleet ls`'s ACTIVITY column and `--json` renderer (`readiness-format.ts`)
   get one new branch each, checked before the existing `select` branch, so a
   dead account reads `DEAD · org disabled subscription access` /
   `lead: "dead"` rather than falling through to the ordinary `limit` shape.

## Files touched

- `src/studio/rate-limit.ts` — `AccountLimitState.dead?: true`,
  `RateLimitObservation.dead?: true`, `decodeAccountLimitState` carries/
  rejects it, `formatRateLimited` gets a first branch for it.
- `src/studio/accounts.ts` — `AccountLimitEntry.dead?: true`,
  `accountIsFree` checks it first, unconditionally.
- `src/studio/failover.ts` — `DEAD_ACCOUNT_HEADLINE`/`DEAD_ACCOUNT_LINE`,
  `deadAccountBlock`, wired into `detectLimitOnScreen`'s existing chain,
  `PaneVerdict`'s modal variant gains `dead?: true`, `limitObservation`
  threads it, `FailoverDeps.accountLimits.write` gains the 4th param, the
  `runAccountFailover` write call site passes `seen.dead` through.
- `src/studio/do.ts` — `readFleetAccountLimits`/`writeFleetAccountLimit`
  carry `dead` to/from D1, the `FailoverDeps.accountLimits` wiring passes it.
- `cli/readiness-format.ts` — `formatActivity`'s dead branch, `LsJsonRow`'s
  `lead` union gains `"dead"`, `lsJsonRows`' dead branch.
- `test/fixtures/rate-limit-panes.ts` — `ORG_DISABLED_PANE`, a NOT_DETECTED
  prose entry.
- New/extended tests: `test/studio.failover-dead-account.test.ts` (detector),
  `test/studio.account-failover.test.ts` (`accountIsFree`/`nextClaudeAccount`/
  end-to-end `runAccountFailover`), `test/studio.rate-limited.test.ts`
  (encode/decode round-trip, `formatRateLimited`), `test/cli.fleet.test.ts`
  (`formatActivity`/`lsJsonRows`).

## Residuals, stated rather than hidden

- No automated way to clear a dead account back into rotation — by design,
  the whole point of this feature. A human clears the fleet_state row
  (`account-limit:<name>`) directly, or fixes it in the Anthropic console and
  clears the row, once org subscription access is restored.
- The detector's bottom-anchoring rules mean a dead-account line that is
  physically on screen but NOT at the very bottom (e.g. an older turn's
  output, scrolled up under newer output) is not detected by
  `deadAccountBlock` alone — same residual every OTHER bottom-anchored
  detector in this file already states for itself (`anyLiveLimitLineOnScreen`
  exists as the position-free veto for the RESETS-bearing shapes; this
  message gets no equivalent veto, since it is new and unmeasured against a
  real "still physically on screen but not bottom-anchored" capture — should
  one surface, the fix is the same generalization `anyLiveLimitLineOnScreen`
  already provides for the other shapes).
- Round 2 review (maestro review of PR #152, 2026-09-30) — `DEAD_ACCOUNT_WRAP_LINES
  = 3` may not be enough rows for the full sentence to reconstruct at very
  narrow pane widths (below roughly 78 columns): the measured real pane
  (~120 cols) wraps to 2 rows and the hand-wrapped 80-col fixture also fits in
  2, but a genuinely narrower pane could push the sentence past 3 rows and the
  detector (both `deadAccountBlock` and its round-2 sibling
  `countDeadAccountOccurrences`, which reuses the identical wrap-tolerant
  reconstruction) would then miss it entirely. Known, accepted gap — not fixed
  this round. If a narrow-pane miss is ever measured, raising
  `DEAD_ACCOUNT_WRAP_LINES` is the fix, same as it was chosen generously the
  first time.

## 2026-10-01 — issue #156: test-only follow-up, anchor-mutant coverage gap

The existing `NOT_DETECTED_141` fixtures (prose-prefixed sentence, sentence
quoted inside a `⎿` tool-output line, glyph-anchored but paraphrased ending)
all leave the sentence's own line preceded by SOME other text, so a mutant
that merely loosened "nothing before the sentence except the glyph" to
"nothing before the sentence except possibly a glyph" could still coincide
with all three passing. Added a fourth `NOT_DETECTED_141` fixture: the exact
canonical sentence sitting bare at column 0 of its own line, no `⏺`/`●`
prefix at all — closing that gap for `detectRateLimitModal`. Added a sibling
test for `countDeadAccountOccurrences` (the scrollback-redraw occurrence
counter, which reuses `DEAD_ACCOUNT_START_LINE` identically) proving the same
bare line is never counted as an occurrence. Verified both are genuine
mutant-killers by temporarily making `DEAD_ACCOUNT_START_LINE`'s glyph
optional, confirming both new tests go RED, then reverting. Test-only; no
production code changed.
