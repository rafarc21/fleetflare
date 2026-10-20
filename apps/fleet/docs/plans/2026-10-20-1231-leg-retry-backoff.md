# Plan — task #1231: leg step retry limit + backoff, combined causes

Branch `fix-1231-leg-retry-backoff`; no PR yet.

## The measured rationale

The ONE existing step-retry on a leg's `start-<leg>` step (Cloudflare
Workflows' own `retries.limit: 1`) already rescues 86% of first infra
failures (279/326 on 2026-10-19). `P(2nd failure | 1st failure)` is 14% —
small, but not zero, and a leg that still exhausts its one retry today
gives up for good even though a second retry would plausibly rescue a
chunk of that remaining 14%. Cost is paid only on legs that are actually
failing; a leg that succeeds on its first or second attempt never sees the
extra retry.

## The exact config change

`LEG_STEP_CONFIG` (leg-run.ts) goes from

```ts
{ retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "30 minutes" }
```

to

```ts
{ retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "30 minutes" }
```

A leg now gets up to 2 infra retries (3 total attempts) before giving up,
on a fresh DO + container each attempt (existing behavior, unchanged). The
backoff switches from constant 15s-each to exponential from the same 15s
base delay. `LegStepConfig.backoff` widens from the literal `"constant"`
to `"constant" | "exponential"` so the type still describes both configs
in the file; `BUNDLE_STEP_CONFIG` (a separate, unrelated config with
`retries.limit: 0`) is untouched — `backoff` there stays `"constant"`, and
at `limit: 0` there is no retry to back off, so the field is moot for it.

## The `combineCauses` mechanism

Today, when a leg's `start-<leg>` step runs out of retries, the thrown
error carries only the LAST attempt's cause — the earlier attempt's cause
(the one the retry was trying to rescue) is lost. With `retries.limit`
raised to 2, that loss would now compound across 3 attempts instead of 2.

`runLegStep`'s `attempt(...)` closure already declares `let tryNo = 0;`
once per `step.do(...)` call, and that closure is reused across Workflows'
own internal retries of that same step (same JS closure instance, called
again on each retry — this is also how `tryNo` already works today). A
sibling `const causes: string[] = [];` accumulates one entry per failed
attempt within that same `step.do` call: each `catch` block now pushes its
per-attempt cause (unchanged: still cut at `MAX_INFRA_CAUSE_CHARS` = 200,
then appended with its wall time) onto `causes`, then throws
`new Error(combineCauses(causes))` instead of a single fresh message.

`combineCauses` joins every cause with `"; "` and caps the joined string at
a new `MAX_COMBINED_CAUSE_CHARS` = 140 — short enough to read as one line,
generous enough for 2-3 short causes — marking a cut with an ellipsis
rather than truncating silently.

Given `retries.limit: 2`, `attempt(...)`'s promise can only ever reject
after ALL 3 attempts have thrown (any attempt that succeeds resolves
`step.do` and no error ever propagates to the outer `.catch`). So by the
time a final error reaches `runLegStep`'s outer `.catch((err) => ({ ...,
description: message.slice(...) }))` (for both the `first`/start-<leg> and
`retry`/retry-<leg> steps), `causes` always has exactly 3 entries — no
conditional "1 cause" or "2 cause" case is reachable with this config, so
none is coded.

The outer `.catch` sites already just forward `err.message` into
`description` (sliced at the unrelated, much larger 2000-char
`MAX_DESCRIPTION_CHARS`), so they need no change: `err.message` is now
already the combined, <=140-char string, well under 2000, so that slice is
a no-op there.

## Pre-existing tests whose expectations changed, and why

All in `apps/fleet/test/bun/gate-leg-run.test.ts` and
`apps/fleet/test/bun/gate-hung-leg.test.ts`, whose own `fakeStep()` helpers
mirror Workflows' retry loop exactly
(`for (attempt=0;; attempt++) { try { return await fn() } catch (err) { if
(attempt >= config.retries.limit) throw err } }`). With `limit` now 2, any
test whose `dispatch` fails on EVERY call (no eventual success, no eventual
red-but-not-infra reply) now takes 3 total calls before the step gives up,
not 2, and the final thrown message is `combineCauses` of 3 causes, not 1.

- "start step config: ..." — the expected config object changes to
  `limit: 2, backoff: "exponential"`; title reworded.
- "non-2xx: retried once; ..." — persistent 503 now takes 3 calls;
  description is `combineCauses([cause, cause, cause])`, computed in the
  test via the real export rather than hand-counted, so the test tracks the
  implementation instead of a frozen string.
- "the infra cause is cut at 200 chars, ..." — same persistent-503 shape;
  expected description recomputed via `combineCauses` over the three
  (already-200-char-cut) per-attempt causes.
- "non-2xx with a non-JSON body: ..." — persistent 502; same fix.
- "a start-step infra retry gets a new attempt id" — `ids` now has length 3
  (one dispatch per attempt), not 2; all three must be pairwise distinct.
- "a hung DO call ends as infra ..." (gate-hung-leg.test.ts) — a
  persistently-hanging dispatch now takes 3 attempts, so `signals` has
  length 3, not 2.
- "an install retry that dies as infra still ends as error ..." — the
  retry-<leg> step's dispatch is persistently 503 (after the first-attempt
  "install failed" data reply), so it also now takes 3 calls inside that
  one step, and its final description is `combineCauses` of the retry
  step's 3 identical causes (not a single cause) joined with
  `"; first: <INSTALL>"` from the outer flaky-cause logic, unchanged.

Everything else in both files has at most ONE infra-failing call before a
differing reply (success, or a red "failure" state, which never throws) —
unaffected by the limit bump; confirmed by running the files.

`gate-infra-rerun.test.ts` and `gate-bundle.test.ts` were checked and need
no changes (the former's assertions use `.toContain(...)`, not exact
counts or strings; the latter's `BUNDLE_STEP_CONFIG` keeps
`retries.limit: 0`, untouched).

## New tests (#1231)

- `runLegStep`: two infra failures then success on the third attempt is now
  the leg's success (previously unreachable with `limit: 1`).
- `runLegStep`: three infra failures with distinct causes end in a final
  error whose description contains all three causes, capped at 140 chars.
- `combineCauses` unit tests: causes that fit untouched (joined with
  `"; "`, no ellipsis), and causes that overflow 140 chars (result is
  exactly 140 chars, ends with `"…"`).

## Files touched

- `src/gate/leg-run.ts` — `LegStepConfig.backoff` union, `LEG_STEP_CONFIG`
  (`limit: 2`, `backoff: "exponential"`), `MAX_COMBINED_CAUSE_CHARS`,
  `combineCauses`, `attempt`'s `causes` accumulator.
- `test/bun/gate-leg-run.test.ts` — updated expectations (above) + 2 new
  `runLegStep` tests + `combineCauses` unit tests.
- `test/bun/gate-hung-leg.test.ts` — updated `signals` length expectation.

## What's out of scope

- `isRetryable`'s flaky-retry (`retry-<leg>`) step shares `LEG_STEP_CONFIG`
  as before — its own internal infra-retry behavior changes identically
  (now up to 3 attempts inside that one step too), covered by the existing
  "install retry that dies as infra" test fix above, not a new mechanism.
- `BUNDLE_STEP_CONFIG` — unrelated, untouched.
- Any change to the actual Workflows runtime backoff math — this is Cloudflare
  Workflows' own built-in `backoff: "exponential"` behavior, not something
  this repo implements.
