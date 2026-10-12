# Plan — #507: EXEC_CLASSES.inspect budget = INSPECT_EXEC_MS by reference

Refs https://github.com/rafarc21/fleetflare/issues/507 (sweep-14 S14-F3, parent https://github.com/rafarc21/fleetflare/issues/485, doc docs/maintainability/2026-10-12-magic-numbers-sweep-14.md). Tier GLM-OK, two-way door.

Problem: sandbox-api.ts:163 re-states inspect.ts:94's INSPECT_EXEC_MS (15_000) as a raw `timeoutMs: 15_000` in EXEC_CLASSES, while the table's own doc comment (:104) says the number IS that constant — a budget change in inspect.ts silently leaves the exec class at 15s with a comment that lies.

Change: (a) sandbox-api.ts imports INSPECT_EXEC_MS from ./inspect — no cycle: only do.ts/terminal.ts import sandbox-api, and inspect's transitive closure never reaches it — and the `inspect:` entry uses the constant instead of the literal; (b) RED source-pin test: vitest.config.ts binds sandbox-api.ts's source text as env.TEST_SANDBOX_API_SRC (same idiom as TEST_STUDIO_DO_SRC; workerd has no filesystem) + test/env.d.ts type line + one case in test/studio.exec-deadlines.test.ts asserting the inspect line names the constant. The existing `toBe(15_000)` value characterization in that file stays — the value is identical, only the spelling changes.

Steps: 1) this doc on branch fix-507-inspect-exec-ms from origin/main, push. 2) RED: binding + test case → `bun x vitest run test/studio.exec-deadlines.test.ts` fails on the new case; commit, push. 3) GREEN: import + literal swap → same suite green, test/studio.inspect.test.ts characterization green; commit, push. 4) Gates one at a time: `flock /tmp/fleet-gate.lock bun run check`, `bun run english-check`, `bun run test-lies-check`; record exact tails for /workspace/.fleet/done/507.json.

Boundaries: value stays 15_000; no other EXEC_CLASSES entry or doc-comment line touched; the heavy gate (`bun run check`) runs ALONE under flock, never parallel with anything.
