# Plan — task #1226: gate/verdict post must retry and fail loudly

Branch `fix-1226-gate-verdict-post-retry`; no PR yet.

## The bug, precisely

`src/gate/status-post.ts`'s `postGateStatus` tries posting the gate/verdict
commit status twice, immediately (no delay), and on both failing just
`console.error`s and returns `true` (a boolean `statusPostFailed`) — it
NEVER throws. Every caller in `src/gate/workflow.ts` wraps it in
`step.do("post-X", async () => postGateStatus(...))` with no explicit retry
config, so Workflows uses its own default step retry — but since
`postGateStatus` never throws, that step always resolves successfully (with
`statusPostFailed: true` buried in the result), so Workflows' own
retry-with-backoff never fires.

Observed in production: a run that finished 24/24 green had its final
verdict POST silently fail, the Workflow instance completed "successfully"
with `statusPostFailed: true`, and the PR's GitHub status sat on "pending"
for 23+ minutes, blocking the merge queue, with nobody and nothing
retrying it.

## The fix: throw, confirm by reading back, let Workflows retry for real

`postGateStatus` now makes ONE attempt per call: mint a token, POST the
status, then read gate/verdict back (`getCommitStatus`) to confirm it
actually landed — a 2xx response is not proof under a secondary rate limit
or an eventually-consistent read. It resolves (void) only when the
read-back matches the state+description just posted; otherwise it throws,
carrying the real cause (the POST's own error, or a description of the
read-back mismatch when the POST itself returned 2xx but didn't stick).

Every `step.do("post-X", ...)` call site in workflow.ts (and the two
`WatchdogDeps.post`/`announceInfraRerun` call sites that share this
contract) gets an explicit retry config, `STATUS_POST_STEP_CONFIG` (5
tries, exponential backoff from 10s, 5-minute step timeout) — not
Workflows' implicit default, so the retry is a promise this file can
actually keep. Workflows re-runs the WHOLE function on each retry; the
post is idempotent (reposting the same state/description is harmless), so
repeating mint+post+confirm on retry is always safe.

When a step exhausts `STATUS_POST_STEP_CONFIG`'s retries, the step's
promise rejects, propagating out of `run()` as an uncaught exception —
this ends the Workflow INSTANCE itself in "errored" status, carrying the
real thrown error. That is the "step fails loudly" the issue asks for:
nothing can read the final state as a quiet `statusPostFailed: true`
anymore, because reaching any `return` in `run()` now means the post
already confirmed landing.

`GateRunOutcome`'s `statusPostFailed: boolean` field is kept as-is for
backward compatibility (cli-gate.test.ts and gate-routes.test.ts pin
callers that still read it) — it simply can never be observed `true` from
these call sites again; a literal `false` is written at every return that
follows a successful `step.do`.

## Why `getCommitContextStatus` is added to `src/github/api.ts`

The issue's stated boundary is `src/gate/**`, but the read-back needs one
new raw GitHub HTTP call — reading a commit's current statuses via the
combined-status endpoint (`GET /repos/{repo}/commits/{sha}/status`). Every
other raw GitHub call in this system already lives in `github/api.ts`
(including `postCommitStatus`, immediately above where this is added) —
that file is a deliberate single point for GitHub HTTP, and `ghRequest`/
`ghJson` are private to it. Duplicating that plumbing inside `src/gate/**`
to keep the diff boundary literal would fork GitHub error-handling for one
read-only helper, which is the worse outcome. This is the one small,
necessary, read-only exception; everything else stays inside
`src/gate/**`.

## The five changes

1. **`src/gate/status-post.ts`** — `StatusPort` gains `getCommitStatus`;
   `postGateStatus` makes one attempt (mint, post, confirm by read-back)
   and throws (carrying the real cause) instead of looping twice and
   swallowing. Adds the exported `STATUS_POST_STEP_CONFIG`.
2. **`src/github/api.ts`** — new `getCommitContextStatus(token, repo, sha,
   context)`, mirroring `postCommitStatus`'s style (`ghJson`, a `label`
   string). Returns `{ state, description? } | undefined`.
3. **`src/gate/workflow.ts`** — `statusPort()` wires `getCommitStatus` via
   `getCommitContextStatus`; every `post-*` step.do call gets
   `STATUS_POST_STEP_CONFIG` as its explicit config; every
   `const statusPostFailed = await step.do(...)` becomes a bare `await`,
   and the later `return`s carry a literal `statusPostFailed: false`.
4. **`src/gate/infra-rerun.ts`** — `announceInfraRerun`'s `post` param and
   its own return type both go from `Promise<boolean>` to `Promise<void>`
   (throws instead of returning true); `touch` runs before `post`,
   unchanged.
5. **`src/gate/watchdog.ts`** + **`src/gate/watchdog-env.ts`** —
   `WatchdogDeps.post` follows the same void/throw contract.
   `endRunFinal`'s post failure path becomes a try/catch preserving the
   same two branches (final-age gives up and logs the real error; earlier
   restores the progress stamp and rethrows the ORIGINAL error, not a
   generic message). New `WatchdogDeps.headStatus` dependency: a run that
   ends "errored" without ever posting its own verdict gets ONE
   best-effort reconciliation post (`state: "error"`), but ONLY when the
   head's real GitHub status isn't already something terminal — this
   never clobbers a verdict some other path already landed.
   `watchdog-env.ts`'s real wiring adds `getCommitStatus` to its
   `StatusPort` and builds `headStatus` from the same port/token-mint.

### Deliberate simplification in watchdog.ts's reconciliation (5b)

The errored-run reconciliation post is best-effort only: a failure there is
caught and logged (`console.error`), not retried, and the run is retired
either way. `endRunFinal`'s normal final-verdict path keeps its existing
retry-until-final-age behavior because that run is still live and
one-at-a-time from the sweep's own per-row loop; the reconciliation path
is deliberately lighter because the run is already dead by the time it is
reached (status read as "errored") — there is no live run left to keep
retrying against, and the next sweep will not see this row again once it
is retired. A lost reconciliation post here is the same risk the issue
describes (a quiet pending status), but it is scoped to the rarer
errored-with-no-verdict case, not the common path, and over-engineering a
full retry loop for a dead run is out of scope for this fix.

## Tests

- `test/bun/gate-pending-status.test.ts` (the existing dedicated unit test
  for `postGateStatus`/`StatusPort`) rewritten for the throw/confirm
  contract: post fails but read-back confirms it landed anyway (resolves);
  post succeeds (2xx) but read-back shows something else (throws,
  mismatch in the message); post throws and read-back never confirms
  (throws with the ORIGINAL error's message, e.g. containing "503"); a
  `fakeStep()`-style loop (matching `gate-leg-run.test.ts`/
  `gate-infra-rerun.test.ts`'s helper) calling `postGateStatus` through
  `STATUS_POST_STEP_CONFIG`'s retries: fails twice then lands, and always
  fails -> the final thrown error still carries the real HTTP-status-ish
  detail.
- `test/gate-workflow-precheck.test.ts` — one new end-to-end case: the
  verdict POST fails on its first attempts (mock fetch rejects) then
  succeeds, driven through the REAL Workflows step engine
  (`disableSleeps()` bypasses the backoff wait, same pattern already used
  for the shared-head-guard retry test); the final `GateRunOutcome` has
  `statusPostFailed: false` and the mocked combined-status GET reflects
  the landed verdict.
- `test/bun/gate-infra-rerun.test.ts` — `announceInfraRerun`'s existing
  test updated to the void/throw contract, plus a new case where `post`
  throws and the error propagates.
- `test/bun/gate-watchdog.test.ts` — `harness()`'s `post` fake and every
  inline `post: async (...) => {...; return false;}` site updated to throw
  on failure instead of returning a boolean. Two new tests: an "errored"
  run with no existing head status gets exactly one reconciliation post
  (`state: "error"`, description mentioning "ended without a verdict") and
  is retired; an "errored" run whose head already shows a terminal status
  (e.g. `{ state: "success" }`) gets NO reconciliation post and is still
  retired.

No test in this change ever posts a real commit status against GitHub —
every test uses fakes at the `StatusPort`/`WatchdogDeps` boundary or a
mocked `fetch`.

## Commit plan

1. This plan doc.
2. `status-post.ts` + `github/api.ts` + `gate-pending-status.test.ts`.
3. `workflow.ts` + `infra-rerun.ts` + `gate-infra-rerun.test.ts` +
   `gate-workflow-precheck.test.ts`.
4. `watchdog.ts` + `watchdog-env.ts` + `gate-watchdog.test.ts`.
