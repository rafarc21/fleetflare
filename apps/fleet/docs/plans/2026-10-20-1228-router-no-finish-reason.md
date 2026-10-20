# Plan — task #1228: router no_finish_reason poison-request guard

Branch `1228-router-no-finish-reason`; PR #1235 (already marked ready for
review). Retroactive doc: this branch was carried by two prior OSS lead
sessions with no plan doc ever committed, unlike every other recent task in
this directory. Written after the fact from the real commits/diff/tests,
not from memory.

## The incident

A poison request on a consumer repo burned ~18M tokens in one day: the same
Claude Code client resent the IDENTICAL request body 12x against the same
model, and every single attempt died the same way — `no_finish_reason`
(the upstream OpenAI-compatible stream ended cleanly, never once sending a
chunk that carried a `finish_reason`), with 0 output tokens every time. The
router answered with a retriable status (`overloaded_error`, 529), which is
exactly what a well-behaved client does with a retriable error: it retries
the whole turn. Nothing in the router distinguished "this exact body is
provably poisonous to this model" from "a normal transient overload" — so
the client's own correct retry behavior turned one bad request into 12
billed calls.

## The fix: fingerprint, retry-once-then-failover, 3-strike non-retriable

Three parts, all in `src/llm/anthropic-route.ts` and `src/llm/model-store.ts`:

### (a) Request fingerprint — hashes and sizes only, never raw text

`computeRequestFingerprint(raw, body)` (anthropic-route.ts) hashes the whole
raw body (SHA-256) as the durable "identical input" signal — a poison
request recurs even after `/clear` (fresh message history), so the poison
lives in system/tools/request SHAPE, not conversation state. Alongside the
whole-body hash it records `bodyBytes` (the real UTF-8 byte length via
`TextEncoder().encode(raw).byteLength` — NOT `raw.length`, which counts
UTF-16 code units and undercounts any multi-byte content), `toolCount`, and
the last `tool_result` block's flattened-content hash + byte size (the
exact same string-flatten rule `translate.ts`'s `flattenTextLike` already
uses: `string | [{text}]`). `logNoFinishReasonFingerprint` writes ONE
console line per genuinely-poison failure carrying these hashes/sizes plus
the last 2 raw upstream `data:` chunk payloads (also hashed, not logged
raw — they are model OUTPUT already sent toward the client, but hashed
anyway for consistency with everything else on the line) and the upstream's
own reported usage. Every field on that line is a hash or a count; no
prompt or completion text ever reaches it.

Gated by one shared predicate, `isPoisonNoFinish(r)`:
`r.failure === "no_finish_reason" && r.outputTokens === 0`. The incident's
own data shows poison runs die after 0-1.6k output tokens, not always
exactly 0 — a `no_finish_reason` that DID produce some output is a normal,
transient failure (the model answered, then the stream cut), not proof the
BODY is poisonous. Only the out=0 shape is fingerprinted, logged, and
counted toward the 3-strike streak below.

### (b) Same-model retry once, then pool failover — non-streaming only

Inside `runModelPoolOverflow`'s walk over the candidate model list,
`attemptOnce()` consumes one `env.AI.run` value and decides: accept (a
plain success, a pump bug, or anything that isn't an out=0
`no_finish_reason`) or reject (remember the frame, retry). The walk retries
the SAME model once on a reject, then moves to the next pool candidate if
one exists; if every candidate rejects the same way, the walk reports
`kind: "no_finish_exhausted"`.

The streaming path cannot do this — by the time a `no_finish_reason` is
known, the `Response` (and its headers) already left the Worker, so there
is nothing left to retry or fail over. It still runs the same
`isPoisonNoFinish` check on the pump's resolved result and, when true,
fingerprints + calls `recordNoFinishReasonFailure` from inside
`ctx.waitUntil` — not to fix THIS call, but so the entry gate below catches
the client's NEXT identical send before it burns any more budget.

### (c) Atomic per-studio-per-fingerprint D1 streak + entry gate

`recordNoFinishReasonFailure(db, studioId, fingerprintHash, now)`
(model-store.ts) is ONE `INSERT INTO fleet_state ... ON CONFLICT(key) DO
UPDATE ... RETURNING value` statement: a live (unexpired) stored
`count|expiresAtMs` increments the count and extends the expiry; an absent
or expired one resets to a fresh streak of 1 — decided and written inside
the SAME statement SQLite resolves the conflict with, never a preceding
read. `NO_FINISH_REASON_WINDOW_MS` = 1 hour (a poison run burns its 3 tries
in seconds; an hour still catches a client retry loop minutes later without
leaking into an unrelated later turn). `recordAndRespondNoFinish` wraps the
increment with the response shape: under 3, `overloaded_error` 529
(retriable — move the client's turn on); at 3 or more, `invalid_request_error`
400 — the one shape Claude Code reads as "stop, don't retry", breaking the
12x resend loop for good. `clearNoFinishReasonFailures` (a bare `deleteFlag`,
unconditional) runs on every success path so a request proven
non-poisonous starts the next identical-input failure as a fresh streak,
not a continuation.

`handleFleetAnthropicMessages` checks `getNoFinishReasonFailures(...) >= 3`
right after fingerprinting, BEFORE the model-pool walk runs at all — a 4th
identical send is refused outright with the same 400, spending zero AI
budget instead of repeating the full retry-then-failover walk just to land
on the same answer.

## Review: 8 round-1 findings, 4 round-2 findings

Two fresh-context review rounds ran against PR #1235 after the initial
`wip`/test commits landed.

**Round 1 (8 findings):**
- F1 — the final non-streaming failure branch keyed on bare
  `result.failure === "no_finish_reason"`, missing the `outputTokens === 0`
  gate the retry walk itself already used — a no_finish_reason WITH output
  (a normal flaky failure) got double-counted toward the 3-strike streak
  and double-logged for the same frame.
- F2 — `recordNoFinishReasonFailure` was `getFlag` then `setFlag`: two
  non-atomic D1 round trips, the exact get-then-set race `state.ts`'s own
  `incrementCounter` (PR #9 review, BLOCKER F1) already exists to prevent
  ("20 concurrent calls against a cap of 3 all succeed"). The
  retry/failover walk calls this more than once per request across models,
  plus genuinely concurrent client retries, for the same studio+fingerprint
  — a plausible way to bypass or trip the gate early. Rewritten as the
  atomic `INSERT ... ON CONFLICT ... RETURNING` described in (c) above.
- F3 — no test exercised the tool_result-specific hashing branch with
  sensitive content; every existing secret-marker test put the marker in a
  plain message, never inside a `tool_result` block.
- F4 — `bodyBytes` used `raw.length` (UTF-16 code units) instead of the
  real UTF-8 byte count every sibling fingerprint field already reports via
  `TextEncoder`.
- F5/F6/F7/F8 (Standards axis, 4 findings) — `attemptOnce()` extracted the
  initial-attempt/same-model-retry's copy-pasted consume-and-check logic;
  `recordAndRespondNoFinish()` extracted the copy-pasted
  record-then-build-529-or-400 logic shared by the `no_finish_exhausted`
  branch and the final failure branch; `ModelOverflowResult` gained a
  `kind` literal tag matching its sibling `ConsumeOutcome` (was ad hoc
  `"x" in overflow` presence checks); `clearNoFinishReasonFailures` dropped
  an unused `now` parameter that falsely implied it was time-gated like its
  two siblings.

**Round 2 (4 findings):**
- F1/F3 — the SAME missing-`outputTokens===0`-gate bug recurred on a THIRD
  call site: the streaming pump's own result handler, the one place round
  1's fix never reached (round 1 only fixed the non-streaming branch and
  `attemptOnce`). Fixed by extracting the one shared `isPoisonNoFinish(r)`
  predicate (F3) and using it at all three call sites, closing off the drift
  class for good rather than re-copying the condition a third time.
- F2 — the defensive `stream: true` fallback success path (a provider that
  ignored `stream: true` and returned a plain object anyway) never called
  `clearNoFinishReasonFailures`, unlike the other two success paths
  (real-streaming success, non-streaming collected success).
- F4 — cosmetic: `runModelPoolOverflow`'s inline ~17-line consume closure
  extracted into a named `consumeNonStreaming` const for readability, no
  behavior change.

## Test coverage added

- `test/llm.anthropic-core.test.ts` (non-streaming) — 3 new tests: an out=0
  `no_finish_reason` retries the same model once then succeeds; every pool
  model exhausts with out=0 `no_finish_reason` (first failure 529
  retriable, third identical-body failure 400 non-retriable); a
  `no_finish_reason` WITH output tokens is NOT poison-counted and falls
  through to the generic error path.
- `test/llm.anthropic-stream.test.ts` (streaming + shared gate) — the
  defensive `stream:true` fallback success path clears the poison streak; a
  stream ending without a `finish_reason` records `no_finish_reason`; a
  streaming `no_finish_reason` WITH output is not poison-counted (a 4th
  identical send still reaches `env.AI.run`, proving the entry gate wasn't
  falsely tripped); a secret marker inside a `tool_result` block never
  reaches any `console.error` call (F3); `bodyBytes` in the fingerprint line
  is the real UTF-8 byte count, not the UTF-16 character count (F4).
- `test/llm.model-store.test.ts` — the streak counter counts up per
  fingerprint and returns the new total; the shared-expiry window resets
  once stale; `clearNoFinishReasonFailures` drops the streak entirely; and
  the atomicity proof for F2's fix — 20 genuinely concurrent calls against
  the same studio+fingerprint produce 20 distinct sequential totals (1..20),
  never two callers reading-then-writing the same post-increment value.

## Final verification

- `bun run check` — exit 0.
- `bun run bun-test-gate` — 3838 pass / 1 skip / 0 fail, exit 0.
- `bun run test` (vitest) — 7116/7116 pass, exit 0.

All three independently confirmed by both the lead and QA.

## Files touched

- `apps/fleet/src/llm/anthropic-route.ts` — fingerprinting, `isPoisonNoFinish`,
  `attemptOnce`, `recordAndRespondNoFinish`, the entry-gate check, the
  retry-then-failover wiring in `runModelPoolOverflow`, and the streak
  clear/record calls on every exit path.
- `apps/fleet/src/llm/model-store.ts` — `recordNoFinishReasonFailure`
  (atomic counter), `clearNoFinishReasonFailures`, `getNoFinishReasonFailures`,
  `NO_FINISH_REASON_WINDOW_MS`.
- `apps/fleet/test/llm.anthropic-core.test.ts`,
  `apps/fleet/test/llm.anthropic-stream.test.ts`,
  `apps/fleet/test/llm.model-store.test.ts` — coverage above.
