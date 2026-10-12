# Plan — #439 S10-F3 telegram message_id narrowing (kill the cast-on-cast)

Refs https://github.com/rafarc21/fleetflare/issues/439 (parent sweep #429, finding F3; doc docs/maintainability/2026-10-12-type-safety-sweep-10.md, landed 47f8959). Tier GLM-OK, bounded ~10 lines, two-way door (pure code).

## Problem

`apps/fleet/src/telegram/api.ts` narrows Telegram's response in two jumps, each trusting the last:

- `:108` — `JSON.parse(text) as TelegramApiResponse` (interface has `result?: unknown`)
- `:139` — `sendCard` does `return (result as { message_id: number }).message_id` — a second blind cast on top of the first
- `:23-27,37` — the `sendMessage` chunker's inline body cast `as { ok?: boolean; description?: string; result: { message_id: number } }`, pushed into `ids` at `:37`

A 200-ok body with a missing/partial `result` (Telegram has done this on partial outages) becomes `undefined` in the returned ids; later `editCard`/`answerCallbackQuery` calls target a broken message_id and the approval-gate card edits silently fail.

## Change

`call()` keeps returning `unknown`. `sendCard` narrows:

```ts
const messageId = (result as { message_id?: unknown } | null | undefined)?.message_id;
if (typeof messageId !== "number") {
  throw new Error("telegram sendMessage returned no message_id");
}
return messageId;
```

The chunker's inline cast becomes `result?: unknown` and the same narrowing runs before `ids.push`. Never a new dependency. No token handling change — the bot token flows through `call()`/`fetch` exactly as today.

## Steps (TDD)

1. RED: three cases in test/telegram.api.test.ts — sendCard on `{ok:true}` (no result), sendCard on `{ok:true, result:{}}`, sendMessage on `{ok:true}` — all expect `rejects.toThrow(/no message_id/)`. Run `bun vitest run test/telegram.api.test.ts` from apps/fleet — the new cases fail. (Observed RED: the two no-`result` cases crash with a raw `TypeError` on the old blind deref; the `result:{}` case resolves `undefined` instead of throwing.) Commit. Push.
2. GREEN: the narrowing above at both sites in src/telegram/api.ts. New cases pass; existing telegram/approvals suites pass UNCHANGED. Commit. Push.
3. Verify, one heavy gate at a time: from apps/fleet, `bun vitest run test/telegram.api.test.ts test/telegram.callback.test.ts test/telegram.chunk.test.ts test/telegram.webhook.test.ts test/approvals.gates.test.ts`; then `bun run check`; then `bun run english-check`.

## Boundaries

- `call()` return type stays `unknown`. No new module, no new dependency, no interface export churn.
- Throw string `telegram sendMessage returned no message_id` at sendCard; the chunker site appends `after ${sent} piece(s)`, matching the file's existing partial-delivery accounting (`failed after ${sent} piece(s)` at its other two throws). Both match the tests' `/no message_id/` regex.
- Branch `fix-439-telegram-message-id` from origin/main (NOT fix-405, which is in gate). Push after the RED commit and every commit after (`LEFTHOOK=0 git push`).
- Heavy gates: `bun run check` (repo-wide tsc across five projects) runs at the end, ALONE, never alongside another gate. Targeted vitest suites are not heavy.
