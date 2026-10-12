# Plan — #451 S6-F5 shortId — one helper behind 10 `randomUUID().slice(0, 8)` spellings

Refs https://github.com/rafarc21/fleetflare/issues/451 (parent sweep #415, finding F5; doc docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F5, landed 83f6a3e). Tier GLM-OK, bounded ~25 changed lines, two-way door (pure helper; revert restores the 10 spellings).

## Problem

The event-id tail expression `crypto.randomUUID().slice(0, 8)` is spelled 10 times across src/ — `tasks/loop.ts:38` (local `rid()`), `telegram/webhook.ts:62,129`, `approvals/gates.ts:105,124`, `board/close-action.ts:184`, `github/webhook.ts:688`, `studio/routes.ts:501`, `deploy/do.ts:90,170`. The "makeEvent id tail = 8 chars" rule never travels as an importable unit; a future call site re-spells it, and a bound change lands in 10 places.

## Change

One export in src/events/schema.ts, next to makeEvent (it IS makeEvent's id convention; schema.ts imports nothing, so every tsconfig project reaches it):

```ts
export function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}
```

All 10 sites import it from events/schema — every one of the 7 files already imports makeEvent from that module, so each edit is: add `shortId` to the existing import braces, replace the raw expression with `shortId()`; `tasks/loop.ts` deletes its local `rid()` (3 call sites at :59, :179, :188 use the new import instead). Wire values unchanged — same expression, same output distribution.

## Steps (TDD)

1. RED: add test file test/events.schema.test.ts (see below). Run `bun vitest run test/events.schema.test.ts` from apps/fleet — module import fails (`shortId` not exported). Commit, push.
2. GREEN: the export in src/events/schema.ts, then swap all 10 sites (7 import lines + 10 expression replacements + delete `rid()`), keeping import ordering per each file's existing sort. Run the new test (3 cases pass) + the characterization suites. Commit, push.
3. Characterization (run between/after GREEN, all green UNCHANGED — no test pins these id strings beyond uniqueness): `bun vitest run test/events.log.test.ts test/events.rules.test.ts test/tasks.loop.test.ts test/telegram.webhook.test.ts test/approvals.gates.test.ts test/board.close-action.test.ts test/github.webhook.test.ts test/studio.routes.test.ts test/deploy.run.test.ts`.
4. Verify, one heavy gate at a time, each ALONE: `bun run check`; `bun run english-check`; `bun run test-lies-check`. Grep envelope: raw expression count in src/ drops to 1 (inside shortId).

## Test (RED-first, characterization, not shape-pinning)

test/events.schema.test.ts — pins behavior of the new export only; existing suites pass unchanged:

```ts
import { describe, expect, it } from "vitest";
import { shortId } from "../src/events/schema";

describe("shortId", () => {
  it("returns 8 characters", () => {
    expect(shortId()).toHaveLength(8);
  });

  it("is hex — makeEvent id tail vocabulary", () => {
    expect(shortId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not repeat across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, shortId));
    expect(ids.size).toBe(200);
  });
});
```

## Boundaries

- No id format change: same expression, same `evt_${now.toString(36)}_${rand}` shape downstream.
- board/close-action.ts and github/webhook.ts edits are import-line-only (sweep-4 scope modules; import swap, not a refactor of them).
- Branch fix-451-shortid-helper from origin/main. Push after the RED commit and every commit after (`LEFTHOOK=0 git push`).
- Heavy gates: `bun run check` (five tsc projects) runs ALONE, never alongside another gate. Targeted vitest suites are not heavy.

---
