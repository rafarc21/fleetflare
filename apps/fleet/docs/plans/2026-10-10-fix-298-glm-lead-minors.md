# GLM lead minors from #297 review (board issue #298)

Ref #297 (merge-approved review), items 1/3/4. Item 2 (60/min tightness)
is ops-watch, skipped per maestro. Tier: bounded fix, no brainstorm.

## Fixes

1. 429 shape (anthropic-route.ts + ratelimit.ts): refusal now returns an
   Anthropic `rate_limit_error` JSON body with a `retry-after` header
   (seconds). `RateLimitResult` refusal arm gains `retryAfterMs` = ms to
   the fixed window's rollover (WINDOW - now % WINDOW), computed in the
   shared core so both junior and lead refusals carry it. Junior's own
   response body stays unchanged.
2. count_tokens (anthropic-route.ts): `estimateInputTokens` now also
   counts tools JSON and array-content blocks, not just string content —
   count_tokens came in low, skewing Claude Code's compact decisions.
   The endpoint now applies the same LEAD per-minute/daily limiter as the
   messages route (parity, no free D1-hammering surface).
3. Mid-stream overflow (translate.ts): `streamErrorFrame` now uses
   classifyAiError's override message, so a context-overflow error chunk
   surfaces as "prompt is too long" in `event: error` — the string Claude
   Code's client recognizes to trigger auto-compact mid-session.

## Tests

TDD, RED then GREEN where a RED run exists: llm.anthropic-route.test.ts
(429 header+body, daily-cap 429, count_tokens tools + rate-limiter,
mid-stream overflow chunk), junior.ratelimit.test.ts (retryAfterMs), bun
llm-translate.test.ts (streamErrorFrame override). The array-content
count_tokens case was already handled pre-fix — translation flattens
arrays before the estimate runs — so its test guards the requirement
end-to-end; no RED run possible. Targeted lanes only: check, the two
vitest files, bun-test llm-translate, english-check, test-lies-check.

## Boundaries

No behavior change to ok:true rate-limit arm, junior's 429 body, streaming
happy path, or translation semantics. Heavy gates run serially.
