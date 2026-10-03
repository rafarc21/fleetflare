# junior usage review follow-up (#221)

Fix task, from PR #220 review (approved, follow-up items). Branched off
`feat-218-junior-usage-counter` (PR #220 unmerged) — this stacks on top,
PR targets that branch, not `main`.

## 1. MEDIUM — local edit-mode undercounts tokens on repair call

`skills/junior/src/main.ts` ~L121-132: on an invalid first edit response,
a repair call runs and `last = second.result` overwrites `last` entirely.
The local usage record (`recordLocalUsage`) reads only `last.usage`, so
the FIRST call's tokens vanish from the local row — server-side records
1 row per HTTP call (both calls counted), local records 1 row per
invocation but only the last call's tokens, an actual undercount, not
just a granularity difference.

Fix: accumulate `usageIn`/`usageOut` across every `callWithPolicy`
resolution (first call, and the repair call if it runs) into running
totals, independent of `last` (which still only needs to track the
latest result for `applyBlocks`/content purposes). Change
`recordLocalUsage`'s signature to take `{in, out}` usage totals and a
`calls` count directly, instead of deriving them from `last: ChatResult`.
The existing `calls` variable already correctly accumulates
`first.calls + second.calls` across retries/model-switches inside
`callWithPolicy` — reuse it directly as the new `calls` field, no new
counter needed.

`LocalUsageRow` (`skills/junior/src/usage.ts`) gains a `calls: number`
field, written into the jsonl line as `calls`. `apps/fleet/cli/junior.ts`'s
`readLocalUsage` sums `row.calls` per row instead of incrementing by 1
per row, so merged `fleet junior stats` totals count real HTTP calls
consistently between the local and server-side halves. Old log lines
written before this fix lack `calls` — treat a missing/invalid `calls`
as `1` there (that's what those rows actually meant under the old
one-row-one-call assumption), not as a reason to skip the line.

Test: a repair round-trip (first response produces unparseable/invalid
edit blocks, second response succeeds) — assert the local usage row's
`input_tokens`/`output_tokens` are the SUM of both calls, and `calls`
is 2, not just the second call's numbers.

## 2. MEDIUM — usage tests must drain `ctx.waitUntil` before reading D1

`apps/fleet/test/junior.usage.test.ts`: several tests (the ok=1 test,
the ok=0 test, the mode-header tests, the insert-failure test) read
`junior_usage_log` right after `await r.text()`, without
`await ctx.drain()` first. Since the insert is handed to `ctx.waitUntil`
(not awaited before the response closes), reading D1 immediately after
`r.text()` is racy — and for the insert-failure test specifically, it
means the "0 rows" assertion could pass for the WRONG reason (the
insert call site simply never running at all) just as easily as for the
right one (the insert genuinely rejecting). Only the one dedicated
"finding 1" test currently drains and asserts `ctx.waitUntil` was
called.

Fix: add `await ctx.drain()` before every D1 read in every test in this
file that calls `handleFleetJunior`, and add
`expect(ctx.waitUntil).toHaveBeenCalled()` (or `.toHaveBeenCalledTimes(1)`)
to each of them too — not just the dedicated finding-1 test — so each
test proves the recording code path actually ran, not merely that its
eventual observable effect matches what an entirely-deleted code path
would also produce.

## 3. LOW — retention: prune `junior_usage_log` rows older than N days

No existing migration change needed — a `DELETE ... WHERE ts < ?`
against the existing table. Mirrors `apps/fleet/src/junior/ratelimit.ts`'s
`pruneStaleCounters` pattern (timestamp-cutoff delete, run opportunistically
on every write rather than a separate scheduled job — this table's
likely row count doesn't justify a cron), NOT `exceptions.ts`'s
`pruneWorkerExceptions` row-count-cap style (that one is a documented
exception, "every other table's delete is a timestamp cutoff").

New `pruneOldJuniorUsage(db: D1Database, now: number): Promise<void>` in
`apps/fleet/src/junior/usage.ts`, retention constant (suggest 90 days),
NEVER throws (internal try/catch + `console.error`, same contract as
`pruneWorkerExceptions`). Called from `apps/fleet/src/junior/route.ts`'s
existing `ctx.waitUntil(insertJuniorUsage(...).catch(() => {}))` call
site — chain it INSIDE the same `ctx.waitUntil` (await insert, then
await prune, in one async IIFE passed to `ctx.waitUntil`) rather than a
second separate `ctx.waitUntil` call, so the existing
`toHaveBeenCalledTimes(1)` assertion in the finding-1 test stays
correct (one `ctx.waitUntil` call per request, same as today).

Test: a focused test calling `pruneOldJuniorUsage` directly with a
fabricated old row (older than retention) and a fresh row, asserting
only the old one is deleted.

## 4. LOW — `readLocalUsage` must skip malformed lines

`apps/fleet/cli/junior.ts` ~L128-145: `readLocalUsage` parses each jsonl
line and accumulates `input_tokens`/`output_tokens` with no validation
that they're actually finite numbers, or that `ts` is present/finite.
A corrupted line (partial write, manual edit) silently poisons every
aggregate with `NaN` (`row.ts < sinceMs` is always `false` for
`undefined`/`NaN`, so a broken row is KEPT, not excluded, then
`NaN`-contaminates every sum downstream).

Fix: after `JSON.parse`, validate `Number.isFinite(row.ts)`,
`Number.isFinite(row.input_tokens)`, `Number.isFinite(row.output_tokens)`,
non-empty string `row.id` — `continue` (skip the line) if any check
fails, same as the existing `catch { continue }` for unparseable JSON.
`calls` (new in item 1) gets its own finite-number check too, defaulting
to `1` only when ABSENT (old-format line), not when present-but-invalid
(a present-but-garbage `calls` is a malformed line, skip it).

Test: a fabricated jsonl file with one well-formed line, one with
`ts` missing, one with `input_tokens: "not a number"` — assert only the
well-formed line's numbers appear in the aggregate.

## Files

- `skills/junior/src/main.ts`
- `skills/junior/src/usage.ts`
- `skills/junior/test/usage.test.ts` (existing tests need a `calls` field added to their row literals)
- `skills/junior/test/main.test.ts` (new repair-round-trip test; existing direct-transport test gains a `calls` assertion)
- `apps/fleet/src/junior/usage.ts` (`pruneOldJuniorUsage` + retention constant)
- `apps/fleet/src/junior/route.ts` (chain prune into the existing `ctx.waitUntil`)
- `apps/fleet/test/junior.usage.test.ts` (drain + waitUntil assertions everywhere; new prune test)
- `apps/fleet/cli/junior.ts` (`readLocalUsage` validation + `calls` summing)
- `apps/fleet/test/bun/junior-stats-cli.test.ts` (malformed-line fixture test)

## Merge Danger

Door: one-way — this branch stacks on `feat-218-junior-usage-counter`
(PR #220), which is already one-way (D1 migration `0004_junior_usage.sql`).
This diff alone adds no new migration, only a `DELETE` against the
existing table plus local/CLI counting fixes. Blast radius: a bad
retention cutoff deletes usage history earlier than intended (recoverable
severity — it's a stats table, not operational state); a bad `calls`/
validation change could under- or over-count `fleet junior stats`, never
breaks an actual `/fleet/junior` call (same `ctx.waitUntil` + internal
try/catch isolation as the parent feature).

## Verification plan

1. Scoped: `bun test skills/junior/test/` (main.ts + usage.ts changes).
2. Scoped: `vitest run apps/fleet/test/junior.usage.test.ts` (drain fixes + prune test).
3. Scoped: `bun test apps/fleet/test/bun/junior-stats-cli.test.ts` (readLocalUsage validation).
4. Full gate, SEQUENTIAL, one at a time (11.6 GiB memory ceiling): `bun run check` → `bun run test` → `bun run bun-test` → `bun run test-lies-check` → `bun run english-check`.
