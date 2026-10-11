# Plan — deepen #373: shared DO-namespace fake helper (S3-F3)

Tests-only refactor, behavior-preserving (sweep-3 doc S3-F3). Census:
6 suites fake `Env["STUDIO"]` with one 4-line shape (name-verbatim
idFromName + get stub + `as unknown as Env` cast): studio.grid,
studio.burn-window-expiry, studio.fleet-resume, studio.profile,
studio.paste, index.

## Steps

1. RED: `test/helpers/fake-namespace.test.ts` pins the contract —
   nsWith(stub) accepts an object stub (get returns it for every id)
   or a function stub (get(id) calls it); envWithNs(stub) spreads the
   vitest env with STUDIO swapped. Commit RED, push.
2. GREEN: `test/helpers/fake-namespace.ts` exporting `nsWith(stub)`
   and `envWithNs(stub, overrides?)`. Unit test passes. Commit, push.
3. Migrate grid, burn-window-expiry, paste (their envWith* wrappers).
   Stub bodies stay local; only the idFromName/get/cast shape moves.
   Run those 3 suites. Commit, push.
4. Migrate fleet-resume, profile, index (inline ns fakes). Run those
   3 suites. Commit, push.
5. Gates serial under flock: 6-suite vitest, `bun run check`,
   english-check, test-lies-check, merge-danger. Done record.
6. Fresh-context review (Spec + Standards axes), then PR.

## Out of scope (hard rule)

studio.routes.test.ts (CLAUDE-ONLY, sweep-3 S3-F7), studio.spawn.test.ts
(auth-mocking), every rescue/failover/auth/credentials suite, and
AGENT/DEPLOY namespace fakes — different bindings, not F3's census.
