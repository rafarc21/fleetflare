# Plan: #1155 llm router follow-ups (refs #1147, refs #1149)

Four follow-ups from the #1149 review. No design changes — a measurement, a
rename, comment corrections, and keeping a measured flag in place.

## Item 1 — measure time-to-headers
env.AI.run blocks before any Response exists, so the pre-header window is
unmeasured. Log it per call:
- new D1 column `time_to_headers` (migration 0010), nullable, lead rows only
- insertJuniorUsage writes it; fallback drops it first (newest-first, like 0006)
- handleFleetAnthropicMessages: `startedAt = Date.now()` (~line 901); compute
  `headersAt = Date.now()` right after runModelPoolOverflow resolves (~line 904);
  logUsage passes `timeToHeaders: headersAt - startedAt` on every call site
- logUsage threads it into the insertJuniorUsage row

## Item 2 — rename the no-flag disconnect test
test/bun/llm-disconnect-workerd.test.ts:109 — without the flag the bounded ping
write still reports the drop locally (no 30s cutoff in local workerd), so
"detects" reads wrong against the PR body. Rename to align with "without the
flag, detection is inert".

## Item 3 — stale comments
- anthropic-route.ts:152-153 "a healthy stream never sends one" is false during
  reasoning. Fix.
- translate.ts:936 "while the upstream is silent" — the clock is now the
  client's silence. Fix.

## Item 4 — keep the flag in every deployed config
Measured (prod, 15s ping): flag -> failure 15.1s; no flag -> 60.2s (cut by the
30s background limit). Add a bun test pinning `enable_request_signal` in every
committed wrangler config except the no-flag control.

## Verification
- bun run check (tsc x5, exit 0)
- vitest run test/llm.anthropic-stream.test.ts test/junior.usage.test.ts
- bun test test/bun/llm-disconnect-workerd.test.ts <new flags test>