# Plan — #1221 triage key tests (amend PR #1220)

Scope: tests-only amend of the #1218 triage credential, plus one small
reservation guard. Branch `1218-llm-router-triage-token`, same PR #1220.

Items (each with a mutation proof for 1-3):

1. Empty configured key + empty `x-api-key` header → 401.
   Mutant: drop the `secret.length === 0` guard in `isTriageDaemonToken`
   (anthropic-route.ts:667) → test turns red.
2. `FLEET_JUNIOR` off + a valid triage key → 404.
   Mutant: drop the flag check (anthropic-route.ts:683) → red.
3. `count_tokens` rate limit returns 429 for `triage--daemon`.
   Mutant: skip `consumeLeadCountTokensRate` (anthropic-route.ts:1151) → red.
4. A second wrong key sharing the first hex char is rejected.
5. Reserve id `triage--daemon`: a real registry row claiming that id is
   rejected (401) in the spawn-token path; document that a spawn-shaped
   value is never accepted as the triage key.

Verification: triage test file, core+stream regression, `check`,
`english-check`, `test-lies-check` — all green.