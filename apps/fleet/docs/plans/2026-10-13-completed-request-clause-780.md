# Plan — #780: "no request is even built" clause unasserted in container.studio-fleet.test.ts

## Scope
Bounded: one test file, `apps/fleet/test/container.studio-fleet.test.ts`, plus this plan. No production code, no other test files. Refs #741, sweep doc docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md.

## Root cause
The test at `container.studio-fleet.test.ts:169` ("refuses `completed` in the CLI itself, naming who owns that verdict — no request is even built") asserts only three `src()` substring checks (the refusal message, "verifies", and the comment "the Worker refuses it too"). Nothing watches the request layer, so the title's final clause is prose inference, not assertion. A refactor that built the request before refusing would still pass.

The claim is in fact true today: `container/studio-fleet` parses `task state <n> completed` into `kind: "usage-error"` at :330-340, and `main()` exits on usage-error at :631-635 strictly before `buildRequest(spawnEnv, cmd)` at :643 — so no request is ever built. This file cannot execute the binary (vitest-pool-workers runs inside workerd, which cannot spawn a bun subprocess — see the file's own header), so the claim gets pinned the same way the sibling test in THIS file pins the identical property for the pre-gate refusal (:288-296): source-ordering of the refusal against the request build.

## Fix (the second option the issue offers: back the clause)
In `container.studio-fleet.test.ts`, inside that same test at :169, add the ordering pin plus a usage-error-gate pin, mirroring the pre-gate sibling:

1. The `completed` refusal is a `usage-error` — the ONLY kind main() exits on before any request:
   `expect(src()).toContain('if (to === "completed") {');`
   `expect(src()).toMatch(/if \(to === "completed"\) \{[\s\S]{0,400}kind: "usage-error"/);`
2. Ordering, same shape as the pre-gate test's: main() must exit on `usage-error` BEFORE `buildRequest(spawnEnv, cmd)` is called — `const refuseIdx = src().indexOf('if (cmd.kind === "usage-error") {'); const buildIdx = src().indexOf("buildRequest(spawnEnv, cmd)"); expect(refuseIdx).toBeGreaterThan(-1); expect(buildIdx).toBeGreaterThan(refuseIdx);`
3. Comment (2-3 lines, why-only): a `completed` refusal is a usage-error and main() exits on usage-error before buildRequest, so no request exists to intercept — pinned by ordering, same technique as the pre-gate refusal test in this file.

No test-name change, no production change, no new file.

## Verification
- Targeted run only: `cd apps/fleet && bun vitest run test/container.studio-fleet.test.ts` (or the repo's vitest incantation) — all tests in the file pass, including the amended one.
- RED: temporarily delete the two added pin blocks (or comment them out) and replace with nothing — test still passes (that is the point: nothing fails today without it) — so RED is instead a MUTATION on the source: temporarily move the `completed` check to AFTER the request build (or change its return kind), run the test, it must FAIL, revert the source. Evidence recorded in the PR body, source reverted before the final commit.
- `bun run english-check` exit 0.
- Heavy gates (full vitest suite, `bun run check` full): NOT run in-studio, belongs to local-ci/merge gate. Targeted vitest run of this one file is the only heavy-ish step, run alone.

## Boundaries
- Targeted test file only. Refs #780/#741 in commits, no closing keyword.
- No CI polling: local-ci status appears on the PR when it runs; do not loop on it.
