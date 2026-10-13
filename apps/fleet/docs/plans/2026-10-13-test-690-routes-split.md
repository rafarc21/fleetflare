# Plan — #690 S26-F3: split test/studio.routes.test.ts (3959 lines) into handle vs accounts halves

Pure move. No logic, no assertion text, no describe-title changes (hazard 5: #NNN provenance is verbatim).

- Half A — apps/fleet/test/studio.routes-handle.test.ts: describes at :425-2198 (8 describes: handleStudio, ROLE_EFFORT, MAX_STUDIOS, terminal, sandbox-api, redactSecrets, dynamic repo, reach) — 98 it()/test() calls.
- Half B — apps/fleet/test/studio.routes-accounts.test.ts: describes at :2199-3959 (9 describes: GET accounts, accounts/sync, #336 held rows, worker-exceptions, brief injection, inspect, wake, repair verbs, LaunchRefused/StartRefused) — 89 it()/test() calls.
- Shared preamble :1-424 copied verbatim into both halves (imports, decodeRolePrompt, FAKE_* fixtures, fakeStorage, fakeStudioNamespace, fakeRescueAnswer, envWithFakeStudio, envWithThrowingVerb, authorizedReq, authorized, afterEach, beforeEach). No helper extraction (hazard 2: split first, dedup second).
- Both halves keep file-level hooks afterEach(:416)/beforeEach(:420); the beforeEach at :3094 lives inside describe #336 and moves with it.
- Trim each half's import block to what that half + its preamble uses (symbol map in task #690 brief; e.g. RepoReach/hashSpawnToken/sbExec stay in A only, writeFleetAccountUsage/resolveClaudeAccounts/LaunchRefusedError in B only). tsc must stay clean.
- Old file apps/fleet/test/studio.routes.test.ts DELETED. Verification: 98+89=187 it/test calls summed equal to before; no assertion-text drift (grep-diff check); both files green under vitest; english-check clean.
- Branch test-690-routes-split; refs #690, #635; never closing keywords; push after every commit.
