# 667 — wip sextuplet → one options object (refs #667)

Plan doc for S32-F2+F3 (board issue #667, sweep docs/maintainability/2026-10-13-long-params-sweep-32.md). Bounded refactor, no behavior change.

## Files

- apps/fleet/src/studio/survival-delivery.ts — resolveSurvivalInput (:654), composeSurvivalDelivery (:1027)
- apps/fleet/src/studio/do.ts — survivalCompose (:6614) + call sites :6507, :6585
- apps/fleet/test/studio.survival-delivery.test.ts — :2162 source-shape assert only

## Type (new, exported from survival-delivery.ts)

```ts
export interface WipSyncSnapshot {
  syncedAt?: string | null;
  bootStamp?: string | null;
  lastAside?: string[] | null;
  lastAsideAt?: string | null;
  syncedBootStamp?: string | null;
  asideShip?: AsideShipRecord | null;
}
```

All six optional: absent field = pre-#208 caller, exactly what the old `= null` defaults meant. `asideShip` keeps undefined-vs-null distinction (never coerce).

## Signatures

1. `resolveSurvivalInput(sources, tasks, session, now, wip?: WipSyncSnapshot)`. Destructure once at top: `const { syncedAt: wipSyncedAt, bootStamp: wipBootStamp, lastAside: lastSessionAside, lastAsideAt: lastSessionAsideAt, syncedBootStamp: wipSyncedBootStamp, asideShip } = wip ?? {}`. Body otherwise unchanged — the six names it reads stay the same names.
2. `composeSurvivalDelivery(sources, tasks, session, now, wip?)` — one-liner pass-through, forwards `wip`.
3. `do.ts survivalCompose(workRepoSlug, session, wip?: WipSyncSnapshot)` — forwards `wip` to composeSurvivalDelivery as an object; the two call sites (:6507, :6585) build one object literal each from the same expressions they pass today.

## Comment discipline

Every existing per-param doc comment MOVES onto the WipSyncSnapshot field it documents (survival-delivery.ts + do.ts + composeSurvivalDelivery's doc block). No comment content deleted, none added.

## Test updates

- :2162 assert string becomes the new survivalCompose signature text (first line: `private survivalCompose(\n    workRepoSlug: string, session: ObservedSession, wip?: WipSyncSnapshot,\n  )` — match whatever formatting the implementation actually lands, use codeOnly/src read at test time to confirm exact text before hardcoding).
- All 50 other call sites in the file pass ≤4 args — untouched.

## Verification (one gate at a time)

1. `bun vitest run test/studio.survival-delivery.test.ts`
2. `bun vitest run test/studio.replacement.test.ts` (real-bring-up compose path)
3. `cd /workspace/fleetflare/apps/fleet && bun run check`
4. `bun run english-check`
