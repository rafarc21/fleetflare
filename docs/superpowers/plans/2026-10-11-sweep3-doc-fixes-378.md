# 378 — sweep-3 doc round-2 review fixes

Doc-only: `docs/maintainability/2026-10-11-test-sweep-3.md` (merged via PR
#379) gets the three cited round-2 findings plus standards minors. Issues
#371-#377 already carry the correct conservative scopes — doc hygiene only.

## Plan

1. F3 scope carve-out: exclude `studio.routes.test.ts:136` (CLAUDE-ONLY per
   S3-F7) and `studio.spawn.test.ts` (auth-mocking) from the GLM-OK target
   list, matching #373's rule.
2. F1 per-file rule: state once — a file with ANY rescue/failover/auth/
   credential/deploy subject is Claude lane, regardless of which describe
   the duplicate lives in — then re-derive F1's GLM-OK examples: drop
   parked-auto-resume, refresh, provision, and the failover-274/
   auto-continue/account-launched/replacement/worktree-session/observation/
   observation-tick/backup-guard/account-unmapped sweep. Apply uniformly to
   F3/F4/F8.
3. Summary tally: "6 GLM-OK (5 scoped + F8), 3 CLAUDE-ONLY, 1 partial".
4. Standards minors: sh() names three of four shapes, Bun.spawnSync not
   execSync; fixedNow ×5 not ×4 (5 files listed); 5352 lines; destroy
   uses fakeCombinedStorage, not in fakeStorage census.

## Verification

- english-check, test-lies-check, `tsc --noEmit` (repo check) — clean.
- Doc grep: tally line matches table; no rescue-file names in GLM-OK lists.
- Two-way door: doc path matches no ONE_WAY_GLOBS pattern.
