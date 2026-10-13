# Plan — #751: shared routes-studio harness helper (refs #733, sweep 33 F7)

Two route suites, `apps/fleet/test/studio.routes-handle.test.ts` and
`apps/fleet/test/studio.routes-accounts.test.ts`, split from one former suite
(PR #728) but keep their provision harness in sync by hand. Measured (2026-10-13,
difflib opcodes): the region handle:29-416 == accounts:31-418 is byte-identical,
388 lines — fakeFetchBlueprintFile, fakeStorage, fakeStudioNamespace,
envWithFakeStudio, STUDIO_ID, the FAKE_* blueprint constants, decodeRolePrompt,
and the `let fakeRescueAnswer` module state. Census estimated ~90; real pair
is ~388 shared lines, routes-accounts drops its whole copy.

## Steps

1. New `apps/fleet/test/helpers/routes-studio-harness.ts` exporting the shared
   block verbatim: `STUDIO_ID`, `decodeRolePrompt`, `FAKE_ROLE_PROMPT`,
   `FAKE_ROLE_MD`, `FAKE_ROLE_MD_KEEP_ALIVE_FALSE`, `FAKE_FLEET_JSON`,
   `FAKE_ORG_JSON`, `fakeFetchBlueprintFile`, `fakeStorage`,
   `fakeStudioNamespace`, `envWithFakeStudio`, `envWithThrowingVerb`, plus
   `rescueAnswer()` getter + `setRescueAnswer()` setter around the `let
   fakeRescueAnswer` (accounts:1934/1944 mutate it; a module-local `let` can't
   be exported directly). Helper imports `env` from "cloudflare:test" —
   precedent: test/helpers/bringup-pins.ts. Both suites keep their own
   beforeEach/afterEach hooks, local symbols (handle: FAKE_ROLE_MD_CTO,
   ROLE_ENV_KEY setKey imports; accounts: FRESH_SESSION_REFUSED_PREFIX etc.)
   stay local.
2. routes-accounts: delete lines 31-418 shared copy, import from the helper,
   rewrite the two `fakeRescueAnswer =` mutation sites as `setRescueAnswer(...)`.
   Unchanged bytes elsewhere.
3. routes-handle: same — delete lines 29-416, import from the helper.
4. Authorized-req dedup is OUT OF SCOPE here except free wins: both files'
   local `authorizedReq` is byte-identical to `test/helpers/http.ts`'s
   exported one, but ~140 call sites per file — NOT touched (mechanical churn,
   census did not ask). Local `authorized()` (vi.spyOn on authModule) stays —
   it closes over each file's own authModule import.

## Verify
- `cd apps/fleet && bun x vitest run test/studio.routes-handle.test.ts test/studio.routes-accounts.test.ts` green.
- `bun run check` (tsc -p test covers the new helper).
- Duplicated-lines proof: `git show` stat — routes-accounts shrinks by ~388.
