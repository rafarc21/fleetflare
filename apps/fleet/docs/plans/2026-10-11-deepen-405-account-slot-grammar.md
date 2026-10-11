# Plan — #405 S5-F7 one slot-name grammar module

Refs https://github.com/rafarc21/fleetflare/issues/405 (parent sweep #394, finding F7). Tier GLM-OK, bounded ~30-line refactor, two-way door (pure code).

## Problem

Both directions of the `CLAUDE_CODE_OAUTH_TOKEN`/`_<n>` slot-name grammar live in two homes with hand-kept symmetry:

- src/studio/accounts.ts:72 — `claudeAccountVarName(position)` (position -> secret name) + private `slotOf` (loop 1..MAX, name -> position)
- cli/accounts-format.ts:277-289 — `slotNumber` (regex parse-back, any _N) + `labelVarName` (name -> `CLAUDE_ACCOUNT_<n>_LABEL`)

A rename of the token secret shape lands twice. cli's copy exists only because accounts.ts sits in an Env-adjacent import graph the pure cli module must not pull in — but cli/accounts-format.ts ALREADY imports NULL_UNTIL_CEILING_MS from accounts.ts (#306), so a shared imports-NOTHING module is the real fix.

## Change

1. New src/studio/account-slot.ts, imports NOTHING (same tsconfig-reachability discipline as src/base64.ts and src/github/mint-token-error.ts):
   - `slotSecretName(position: number): string` — 1 -> CLAUDE_CODE_OAUTH_TOKEN, n>1 -> CLAUDE_CODE_OAUTH_TOKEN_<n> (byte-identical to accounts.ts:72-74)
   - `slotNumberOf(secretName: string): number | null` — the cli regex (/^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/ plus the unsuffixed-first check), null for foreign names
   - `labelVarName(secretName: string): string` — CLAUDE_ACCOUNT_<n>_LABEL, defensive fallback CLAUDE_ACCOUNT_<secretName>_LABEL (byte-identical to cli/accounts-format.ts:286-289)
2. accounts.ts: claudeAccountVarName becomes a one-line re-export of slotSecretName (existing export name kept — test/studio.account-failover.test.ts imports it; a rename would touch every caller for zero behavior change). Private slotOf keeps its 1..MAX window by scanning slotSecretName — window policy (MAX_CLAUDE_ACCOUNTS lives in accounts.ts, account-slot.ts must stay import-free) stays where the constant lives.
3. cli/accounts-format.ts: slotNumber + labelVarName die, buildLabelSuggestions imports labelVarName from ../src/studio/account-slot. Its stale "cannot import accounts.ts" comment block (lines 273-276) dies with them — the module header already documents the real import rule.

## Steps (TDD)

1. RED: round-trip table in a new test file test/studio.account-slot.test.ts — 1 <-> CLAUDE_CODE_OAUTH_TOKEN, 2..9 <-> suffixed, 0/-1 -> suffixed spelling (slotSecretName is total), foreign name -> null, labelVarName for 1/2/foreign. Fails on missing module. Commit.
2. GREEN: add module, rewire both files, existing suites (test/studio.account-failover.test.ts, test/cli.accounts-format.test.ts) pass UNCHANGED. Commit.
3. Verify: vitest run test/studio.account-slot.test.ts test/studio.account-failover.test.ts test/cli.accounts-format.test.ts; bun run check; bun run english-check — one heavy gate at a time.

## Boundaries

- Byte-identical output on every real slot name, including the defensive non-matching-name fallback.
- No credential VALUE ever passes through these functions (names map to names). If credential-adjacent code must move, STOP — not this issue.
- Push after first RED commit and every commit after (LEFTHOOK=0 git push).
- Heavy gates: `bun run check` and `bun run english-check` at the end, one at a time. Targeted vitest suites are not heavy.
