# GLM lead follow-ups (#284)

**Issue:** https://github.com/rafarc21/fleetflare/issues/284

Fix task, not a from-scratch design — follow-ups from #255 round-2 review
(merged). Source of scope is the issue's own text, quoted below rather than
re-derived:

> ## MAJOR (before live proof)
> 1. Rate limit: `src/llm/anthropic-route.ts:209` reuses junior limits
>    (5/min, 50/day per studio, `src/junior/ratelimit.ts:16-17`). A Claude
>    Code lead loops many calls/min -> instant 429. Give GLM-lead its own
>    limits (config, sane defaults e.g. 60/min, generous/day) + test.
> 2. Silent truncation: `src/llm/translate.ts` — upstream stream ends
>    without finish reason, or sends `{"error":...}` chunk -> client sees
>    normal `end_turn`. Must emit `event: error`. RED test each.
>
> ## MINOR
> 1. No `ping` events during long GLM reasoning -> idle timeout risk.
> 2. `message_start` usage always 0.
> 3. Route ignores `JUNIOR_REPOS`; `--lead glm` spawn succeeds while
>    FLEET_JUNIOR off (boots a lead with no model) -> refuse spawn.
> 4. Stream loop not in `ctx.waitUntil`; `/v1/messages/count_tokens` 404.
> 5. 16000 max_tokens floor not pinned by a test.

Dispatch instruction (2026-10-09, second reassignment): both MAJORs first,
then MINOR 3 if cheap. (This doc originally shipped as the first commit on
the branch, when only MAJOR 1 was done; it has since been updated in place
to record final disposition, because every other item also landed on this
same branch in later commits — see below.)

## Full issue scope: final disposition (all items now resolved)

The issue asks for both MAJORs plus 5 MINORs. All seven items have now been
addressed on this branch, either by a code change or by a recorded
assessment. Final disposition, item by item:

- **MAJOR 1** — GLM-lead's own rate limit, separate from junior's. **Done.**
  60/min + 2000/day defaults. See "MAJOR 1" section below for the design.
- **MAJOR 2** — silent stream truncation (upstream ends with no finish
  reason, or sends an `{"error":...}` chunk) must become a real Anthropic
  `event: error`, never a faked `end_turn`/`message_stop`. **Done**
  (commits 75a105f/9a49c22) — `src/llm/translate.ts` now emits `event:
  error` for both failure shapes: the stream ending with no `finish_reason`
  ever set, and an explicit upstream `{"error":...}` chunk. RED test per
  shape, per the issue's own instruction.
- **MINOR 1** — no `ping` events during long GLM reasoning (idle-timeout
  risk). **Assessed, not done.** Implementing this correctly requires
  racing a periodic timer against `pumpAnthropicStream`'s blocking
  `reader.read()` call inside its read loop (`src/llm/anthropic-route.ts`)
  — a real control-flow change (e.g. `Promise.race` between the read and a
  timeout, re-entering the loop on timeout without consuming the pending
  read), not a small bolt-on. Judged not "cheap" per the issue's own
  qualifier ("MINOR — fix if cheap"). Worth a dedicated follow-up task, not
  bundled into this one.
- **MINOR 2** — `message_start` usage always 0. **Assessed, not further
  fixable.** This is an inherent backend limitation, not a bug this
  translation layer can correct: Workers AI's OpenAI-compatible stream only
  ever reports `usage.prompt_tokens` on the FINAL chunk (see `translate.ts`'s
  own existing doc comment on `closeStream`'s `message_delta.usage
  .input_tokens` deviation, added for #249) — there is no way to know the
  real input token count at `message_start` time, before any upstream chunk
  has even been read. This was already the best-available mitigation from
  #249: the real count is deliberately surfaced on `message_delta` instead
  (a documented, flagged deviation from Anthropic's exact wire contract),
  rather than left at 0 everywhere. No further action possible without a
  real upstream tokenizer exposed ahead of generation, which this backend
  does not offer.
- **MINOR 3** — refuse a `--lead glm` spawn while `FLEET_JUNIOR` is off
  (today it would otherwise silently boot a lead studio with no model
  behind it at all). **Done** (commits a1ac826/5090f1a) — a refusal gate
  added at all three `leadType === "glm"` branches in `src/studio/do.ts`
  that spawn/restart/recycle a lead (provision, restart, recycle).
- **MINOR 4a** — stream loop not in `ctx.waitUntil`. **Done** (commits
  126d986/a19e858) — the stream-pump chain in `src/llm/anthropic-route.ts`
  is now handed to `ctx.waitUntil`, matching the existing pattern already
  used for the usage-insert call in the same file.
- **MINOR 4b** — `/v1/messages/count_tokens` 404s. **Done** (commits
  4755e08/7f516a3) — new estimate-only route
  (`ANTHROPIC_COUNT_TOKENS_PATH`, `src/llm/anthropic-route.ts`) added;
  returns a token estimate without making a real upstream AI call.
- **MINOR 5** (16000 `max_tokens` floor not pinned by a test) — **already
  satisfied by prior work, no further action needed.** Confirmed: the
  `GLM_MIN_MAX_TOKENS` floor test already exists in
  `apps/fleet/test/bun/llm-translate.test.ts` lines 102-110 (added in the
  2026-10-08 STATUS-comment-fixes round, see
  `docs/superpowers/plans/2026-10-08-glm-lead-translation-249.md`'s own
  "STATUS comment fixes" section, item 1). This issue's text predates that
  fix landing; re-litigating it here would be pure duplication.

## MAJOR 1 — GLM-lead's own rate limit

`anthropic-route.ts:209` currently calls `checkAndConsumeJuniorRateLimit`
directly — the exact same per-studio D1 counters `/fleet/junior` spends
against (`DEFAULT_JUNIOR_RATE_PER_MINUTE = 5`,
`DEFAULT_JUNIOR_DAILY_CAP = 50`, `src/junior/ratelimit.ts`). A GLM-led studio
is a full Claude Code agentic session — every tool-use round trip is one
Messages-API call to this route — so a 5/min cap sized for occasional
junior-delegation calls 429s a lead into uselessness within seconds of a
normal session starting. This blocks the live E2E proof the maestro needs
to run next.

Fix: a genuinely separate rate limit for the lead route, sharing the real
logic (atomic increment-then-check via `incrementCounter`, minute/day
bucketing, opportunistic stale-row pruning) with junior's limiter rather
than duplicating it — only the D1 key prefixes, env var names, and numeric
defaults differ. Concretely: hoist that shared core out of
`junior/ratelimit.ts` into a new `src/ratelimit.ts`, parameterized by a
small "kind" (key prefixes), with `junior/ratelimit.ts` and a new sibling
`llm/ratelimit.ts` each a thin wrapper supplying their own env var names and
defaults. `junior/ratelimit.ts`'s existing public exports
(`checkAndConsumeJuniorRateLimit`, `DEFAULT_JUNIOR_RATE_PER_MINUTE`,
`DEFAULT_JUNIOR_DAILY_CAP`) stay in place, unchanged in behavior — the
existing `test/junior.ratelimit.test.ts` is the proof nothing regressed
there.

Defaults for the new lead limit: `LEAD_RATE_PER_MINUTE = 60` (the maestro's
own suggested number in the issue text — a Claude Code lead's agentic loop
can legitimately burst many tool-use round trips per minute, each one a
separate Messages-API call). `LEAD_DAILY_CAP = 2000` — generously larger
than junior's 50 (junior is sized for occasional mechanical delegation; a
lead legitimately makes many calls across a full active working day) while
still being a real, low-thousands cap rather than effectively unlimited —
sized to comfortably clear a full day of genuinely active agentic work
without ever being the thing a well-behaved lead actually hits, while still
catching a runaway loop left running unattended overnight.

Wired into `anthropic-route.ts`'s `handleFleetAnthropicMessages`, replacing
the `checkAndConsumeJuniorRateLimit` call at line 209 with the new
lead-specific one. `Env` (`src/env.ts`) gains `LEAD_RATE_PER_MINUTE?:
string` / `LEAD_DAILY_CAP?: string`, doc-commented in the same style as the
existing `JUNIOR_RATE_PER_MINUTE`/`JUNIOR_DAILY_CAP` pair right above them.

Tests (new `test/llm.ratelimit.test.ts`, mirroring
`test/junior.ratelimit.test.ts`'s structure) prove: the new default per-
minute cap is 60, not 5; the new limit is genuinely separate from junior's
(calling one does not consume the other's budget — distinct D1 key
prefixes, same `fleet_state` table, no collision); the daily cap default is
2000. Plus an update to the existing `test/llm.anthropic-route.test.ts`
429 integration test, which currently forces a 429 via
`JUNIOR_RATE_PER_MINUTE` (the pre-fix wiring) and must move to
`LEAD_RATE_PER_MINUTE` once the route no longer reads junior's config at
all.

RED commit: new/updated tests committed first, run against the still-
unmodified route (still calling `checkAndConsumeJuniorRateLimit` directly)
— fail for the right reason (60/min default not observed; module doesn't
exist yet). GREEN commit: the actual refactor + route wiring, tests pass.
Both commits pushed immediately.

## Process

Plan doc (this file) is the first commit on the branch, written when only
MAJOR 1 was done. Every remaining issue item (MAJOR 2, MINOR 3, MINOR 4a,
MINOR 4b) was then also implemented on this same branch in later dispatches
— each as its own RED -> GREEN commit pair, pushed immediately — leaving
only MINOR 1 and MINOR 2 as assessed-but-not-implemented (see dispositions
above for why), and MINOR 5 as already satisfied by prior work. This doc
was updated in place afterward to record that final state. Scoped
verification throughout each dispatch (touched test files + targeted
`tsc`), not the full suite/`bun run check` gate each time — that budget is
reserved, per fleet-wide guidance on shared heavy gates.
