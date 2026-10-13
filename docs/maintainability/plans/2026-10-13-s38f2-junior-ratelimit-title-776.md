# Plan — S38-F2: junior.ratelimit test title claims default, body configures 2 (#776)

Sweep 38 finding F2 (refs #741, docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md): junior.ratelimit.test.ts:29 is titled "blocks the (default + 1)th call within the same minute" but its body sets JUNIOR_RATE_PER_MINUTE: "2" and blocks the 3rd call — a CONFIGURED limit, not the default of 5 (DEFAULT_JUNIOR_RATE_PER_MINUTE, src/junior/ratelimit.ts:22). The default-driven wording is borrowed from llm.ratelimit.test.ts:38, which loops the real default. No assertion changes: the body is correct as written, only the title lies.

## Steps

1. Branch sweep-776-junior-ratelimit-title-38 off origin/main.
2. Retitle junior.ratelimit.test.ts:29 from "blocks the (default + 1)th call within the same minute" to "blocks the (configured + 1)th call within the same minute" — matching the honest spelling its sibling llm.ratelimit.test.ts:73 already uses. One word changed, nothing else in the file.
3. Commit plan doc + retitle together, push branch.

## Verification

- RED check first (title-only change is not behavior, so the mutation test is: confirm the suite fails if the limiter's default were wrong): run `npx vitest run test/junior.ratelimit.test.ts` from apps/fleet — expect green BEFORE and AFTER the change; the one-word diff cannot alter behavior.
- `bun run check` (repo-wide tsc) from apps/fleet.
- `bun run english-check` from apps/fleet.
- `bun run test-lies-check` from apps/fleet.

## Boundaries

- Only files touched: apps/fleet/test/junior.ratelimit.test.ts (one word at line 29) + this plan doc. Nothing else.
- Two-way door: test file only, no ONE_WAY_GLOBS path, no behavior change.
